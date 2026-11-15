import { hasGiftCardActivity } from "@/services/giftCards";
import type { InvoiceData } from "@/types/pos.types";
import type { DbState } from "@/services/idbService";
import type { StorageHealth } from "@/services/storageHealth";
import type { CatalogStatus } from "@/services/catalogSync";
import __ from "@/lib/translate";

export type BlockerCode =
	| "gift_card"
	| "customer_credit"
	| "credit_sale"
	| "return"
	| "price"
	| "payment_mode"
	| "no_offline_modes"
	| "catalog"
	| "storage"
	| "storage_full";

export interface OfflineBlocker {
	code: BlockerCode;
	message: string;
}

export interface OfflinePolicyInput {
	invoice: Pick<
		InvoiceData,
		"items" | "payments" | "is_credit_sale" | "customer_credit" | "is_return" | "return_against"
	>;
	/** POS Profile's allow_zero_rated_items: a free line is only a sale when the profile says so. */
	allowZeroRatedItems: boolean;
	offlinePaymentModes: readonly string[];
	outstanding: number;
	catalog: Pick<CatalogStatus, "status" | "scopeMatches"> | null;
	dbState: DbState;
	storage: Pick<StorageHealth, "level"> | null;
}

/** A sale line that would reach the server at nothing: free/offer/gift-card lines are not sales. */
function isChargedAtZero(line: InvoiceData["items"][number]): boolean {
	if (line.is_free_item || line.is_offer || line.gift_card_issue) return false;
	const rate = line.rate || 0;
	const net = line.discount_percentage
		? rate * (1 - line.discount_percentage / 100)
		: rate - (line.discount_amount || 0);
	return net <= 0;
}

export function offlineSaleBlockers(input: OfflinePolicyInput): OfflineBlocker[] {
	const blockers: OfflineBlocker[] = [];
	const { invoice } = input;

	if (hasGiftCardActivity(invoice)) {
		blockers.push({
			code: "gift_card",
			message: __("Gift cards need a live connection. This sale cannot be saved offline."),
		});
	}
	if (invoice.customer_credit?.length) {
		blockers.push({
			code: "customer_credit",
			message: __("Customer credit needs a live connection. This sale cannot be saved offline."),
		});
	}
	if (invoice.is_credit_sale || input.outstanding > 0.005) {
		blockers.push({
			code: "credit_sale",
			message: __(
				"Credit and part-paid sales need a live connection. Take full payment to sell offline.",
			),
		});
	}
	if (invoice.is_return || invoice.return_against) {
		blockers.push({
			code: "return",
			message: __("Returns need a live connection."),
		});
	}

	const unpriced = input.allowZeroRatedItems ? [] : (invoice.items || []).filter(isChargedAtZero);
	if (unpriced.length) {
		blockers.push({
			code: "price",
			message: __(
				"{0} has no usable price, so this sale cannot be completed offline. Connect, fix the price list, or set the line price by hand.",
				[[...new Set(unpriced.map((line) => line.item_name || line.item_code))].join(", ")],
			),
		});
	}

	if (!input.offlinePaymentModes.length) {
		blockers.push({
			code: "no_offline_modes",
			message: __(
				"No payment method is set up for offline sales on this POS Profile. Ask a manager to list one under Offline Payment Modes.",
			),
		});
	} else {
		const allowed = new Set(input.offlinePaymentModes);
		const refused = [
			...new Set(
				(invoice.payments || [])
					.filter((payment) => (payment.amount ?? 0) !== 0 && !allowed.has(payment.mode_of_payment))
					.map((payment) => payment.mode_of_payment),
			),
		];
		if (refused.length) {
			blockers.push({
				code: "payment_mode",
				message: __("{0} cannot be taken offline. Use: {1}.", [
					refused.join(", "),
					input.offlinePaymentModes.join(", "),
				]),
			});
		}
	}

	if (!input.catalog || input.catalog.status !== "complete" || !input.catalog.scopeMatches) {
		blockers.push({
			code: "catalog",
			message: __(
				"The offline catalogue is not ready or belongs to another session. Connect and let it sync.",
			),
		});
	}
	if (input.dbState !== "ready") {
		blockers.push({
			code: "storage",
			message: __("This browser's offline storage is not available, so a sale cannot be kept safely."),
		});
	}
	if (input.storage?.level === "full") {
		blockers.push({
			code: "storage_full",
			message: __("This device is almost out of storage. Free some space before selling offline."),
		});
	}
	return blockers;
}
