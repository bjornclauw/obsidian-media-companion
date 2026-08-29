import { ListValue, parsePropertyId, type BasesPropertyId } from "obsidian";

/** Helpers for batch edit — extracted for file-size discipline and dedup. */

/** Normalize tag strings: strip leading "#", trim, lower-case. */
export function normalizeTag(tag: string): string {
	return tag.replace(/^#/, "").trim().toLowerCase();
}

export function normalizeTagList(tags: string[]): string[] {
	return tags.map(normalizeTag).filter(Boolean);
}

/** For tags, display strings need "#" prefix to match Bases TagValue rendering. */
export function toDisplayValue(property: string, value: unknown): unknown {
	if (property === "tags" && Array.isArray(value)) {
		return (value as string[]).map((v) => `#${v}`);
	}
	return value;
}

/** Extract string array from a Bases Value (ListValue or raw array). */
function toStringArray(val: unknown): string[] {
	if (val == null) return [];
	if (val instanceof ListValue) {
		const arr = (val as unknown as { value: unknown[] }).value as unknown[];
		if (Array.isArray(arr)) return arr.map((x) => String(x));
		return String(val).split(",").map((s) => s.trim()).filter(Boolean);
	}
	if (Array.isArray(val)) return (val as unknown[]).map((x) => String(x));
	// Fallback: String split for ListValue toString like "#a, #b"
	return String(val).split(",").map((s) => s.trim()).filter(Boolean);
}

/** Equality for pending vs. Bases cur, tag-aware. */
export function valuesEqual(property: string, pendingVal: unknown, cur: unknown): boolean {
	if (pendingVal === undefined) {
		return cur == null || cur === "" || (cur instanceof ListValue && ((cur as unknown as { value: unknown[] }).value?.length ?? 0) === 0) || (Array.isArray(cur) && cur.length === 0) || String(cur) === "" || String(cur) === "null";
	}
	if (property === "tags" && Array.isArray(pendingVal)) {
		const pendingTags = normalizeTagList(pendingVal as string[]);
		// Normalize cur via toString then split
		const curStr = cur ? String(cur) : "";
		const curTags = curStr ? curStr.split(",").map((s) => normalizeTag(s)).filter(Boolean) : [];
		if (pendingTags.length === curTags.length && pendingTags.every((v, i) => v === curTags[i])) return true;
		if (cur instanceof ListValue) {
			const arr = (cur as unknown as { value: unknown[] }).value as unknown[] || [];
			const curNorm = arr.map((x) => normalizeTag(String(x)));
			return pendingTags.length === curNorm.length && pendingTags.every((v, i) => v === curNorm[i]);
		}
		return false;
	}
	if (Array.isArray(pendingVal) && (Array.isArray(cur) || cur instanceof ListValue)) {
		const curArr = toStringArray(cur);
		const pendArr = (pendingVal as unknown[]).map((x) => String(x));
		return curArr.length === pendArr.length && pendArr.every((v, i) => v === curArr[i]);
	}
	return String(cur) === String(pendingVal);
}

/** Resolve BasesPropertyId for a plain property name within current base visibleProperties. */
export function resolvePropertyId(property: string, visibleProperties: BasesPropertyId[]): BasesPropertyId | null {
	for (const pid of visibleProperties) {
		try { if (parsePropertyId(pid).name === property) return pid; } catch {}
	}
	return null;
}

/** Check if a Value is list-like (ListValue or raw array). */
export function isListValue(val: unknown): boolean {
	if (val instanceof ListValue) return true;
	if (Array.isArray(val)) return true;
	if (val && Array.isArray((val as unknown as { value: unknown }).value)) return true;
	if (val && (val as unknown as { constructor: { name: string } }).constructor?.name === "ListValue") return true;
	return false;
}
