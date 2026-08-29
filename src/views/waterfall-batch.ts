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

export type PropertyKind = "list" | "text" | "number" | "boolean" | "date" | "datetime";

function valueClassName(val: unknown): string {
	if (val == null) return "";
	try { return (val as unknown as { constructor: { name: string } }).constructor?.name ?? ""; } catch { return ""; }
}
function isBooleanValue(val: unknown): boolean {
	if (typeof val === "boolean") return true;
	const n = valueClassName(val);
	return n === "BooleanValue";
}
function isNumberValue(val: unknown): boolean {
	if (typeof val === "number") return true;
	const n = valueClassName(val);
	return n === "NumberValue";
}
function isDateValue(val: unknown): boolean {
	const n = valueClassName(val);
	return n === "DateValue" || n === "RelativeDateValue" || n === "DurationValue";
}
function isStringValue(val: unknown): boolean {
	const n = valueClassName(val);
	return n === "StringValue" || n === "TagValue" || n === "UrlValue" || n === "LinkValue" || n === "FileValue" || typeof val === "string";
}

/**
 * Infer PropertyKind from a sample of actual stored values (Bases Value or raw frontmatter).
 * Caller should collect non-null samples from selected items + visible layout items.
 *
 * Priority: list > boolean > number > date/datetime > text.
 * `tags` is always list. Unknown/empty falls back to text (free-form).
 */
export function detectPropertyKind(property: string, visibleProperties: BasesPropertyId[], samples: unknown[]): PropertyKind {
	if (property === "tags") return "list";
	// Filter nullish but keep 0/false for type detection
	const nonEmpty = samples.filter((v) => v != null && String(v) !== "" && String(v) !== "null" && String(v) !== "undefined");
	if (nonEmpty.length === 0) return "text";
	for (const v of nonEmpty) if (isListValue(v)) return "list";
	for (const v of nonEmpty) if (isBooleanValue(v)) return "boolean";
	for (const v of nonEmpty) if (isNumberValue(v)) return "number";
	for (const v of nonEmpty) {
		if (isDateValue(v)) {
			// Distinguish date vs datetime by string representation containing "T" or time
			const s = String(v);
			if (/\dT\d/.test(s) || s.includes(":")) return "datetime";
			return "date";
		}
	}
	// Raw frontmatter date strings like 2024-01-15 may appear as string when sampled via metadataCache.
	// If all non-empty strings look like ISO dates, infer date rather than text.
	const allDateLike = nonEmpty.every((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/.test(String(v).trim()));
	if (allDateLike && nonEmpty.length > 0) {
		const hasTime = nonEmpty.some((v) => String(v).includes("T") || String(v).includes(":"));
		return hasTime ? "datetime" : "date";
	}
	// Numeric strings like "42", "-3.14", "1e5" — treat as number if all samples are numeric-like
	const allNumberLike = nonEmpty.every((v) => typeof v === "string" && /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(String(v).trim()));
	if (allNumberLike && nonEmpty.length > 0) return "number";
	// Boolean strings "true"/"false"
	const allBoolLike = nonEmpty.every((v) => typeof v === "string" && /^(true|false)$/i.test(String(v).trim()));
	if (allBoolLike && nonEmpty.length > 0) return "boolean";
	// Fallback: at least one string -> text, otherwise text
	return "text";
}

export function allowedOperations(kind: PropertyKind): ("replace" | "append" | "remove" | "fill" | "clear")[] {
	if (kind === "list") return ["replace", "append", "remove", "fill", "clear"];
	return ["replace", "fill", "clear"];
}

export function inputConfigForKind(kind: PropertyKind): { type: string; placeholder: string } {
	switch (kind) {
		case "list": return { type: "text", placeholder: "enter values separated by ," };
		case "number": return { type: "number", placeholder: "Enter a number" };
		case "boolean": return { type: "select", placeholder: "true or false" };
		case "date": return { type: "date", placeholder: "YYYY-MM-DD" };
		case "datetime": return { type: "datetime-local", placeholder: "YYYY-MM-DD HH:mm" };
		default: return { type: "text", placeholder: "Enter a value" };
	}
}

export function isValidRawForKind(kind: PropertyKind, raw: string): { valid: boolean; reason?: string } {
	const trimmed = raw.trim();
	if (trimmed === "") return { valid: false, reason: "Empty" };
	switch (kind) {
		case "boolean":
			if (/^(true|false)$/i.test(trimmed)) return { valid: true };
			return { valid: false, reason: "Must be 'true' or 'false'" };
		case "number": {
			// Accept JSON numbers, including negatives and decimals
			const n = Number(trimmed);
			if (!Number.isFinite(n)) return { valid: false, reason: "Must be a valid number" };
			// Reject strings like "12abc"
			if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(trimmed)) return { valid: true };
			return { valid: false, reason: "Must be a valid number" };
		}
		case "date": {
			if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return { valid: false, reason: "Use YYYY-MM-DD" };
			const d = Date.parse(trimmed);
			if (Number.isNaN(d)) return { valid: false, reason: "Invalid date" };
			return { valid: true };
		}
		case "datetime": {
			// Accept YYYY-MM-DD or YYYY-MM-DDTHH:mm[:ss] or space separated
			if (!/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/.test(trimmed)) return { valid: false, reason: "Use YYYY-MM-DD or YYYY-MM-DD HH:mm" };
			const d = Date.parse(trimmed.replace(" ", "T"));
			if (Number.isNaN(d)) return { valid: false, reason: "Invalid datetime" };
			return { valid: true };
		}
		case "list":
			return { valid: trimmed.length > 0, reason: trimmed.length === 0 ? "Enter at least one value" : undefined };
		case "text":
		default:
			return { valid: true };
	}
}

export function parseRawForKind(kind: PropertyKind, raw: string, property: string): unknown {
	const trimmed = raw.trim();
	switch (kind) {
		case "boolean": return /^true$/i.test(trimmed);
		case "number": return Number(trimmed);
		case "date":
		case "datetime": return trimmed; // Store as YYYY-MM-DD string; Obsidian will parse as date
		case "list": {
			let vals = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
			if (property === "tags") vals = [...new Set(vals.map((s) => s.toLowerCase().replace(/^#/, "")))];
			else vals = [...new Set(vals)];
			return vals;
		}
		case "text":
		default: return raw; // preserve original (not trimmed) for text? but use trimmed
	}
}
