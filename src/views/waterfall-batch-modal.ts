import { Modal, setIcon, type App } from "obsidian";

export async function confirmBatchModal(app: App, count: number, property: string, value: unknown, operation: string, selectedPaths: string[], getBasename: (path: string) => string, onFocusReturn: () => void): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new Modal(app);
		const labelMap: Record<string, string> = { replace: "Replace", append: "Append", remove: "Remove", fill: "Fill empty", clear: "Clear" };
		const opLabel = labelMap[operation] ?? operation;
		modal.titleEl.setText(`Apply '${opLabel} ${property}' to ${count} files?`);
		const isClear = operation === "clear";
		const isReplace = operation === "replace";
		const isList = Array.isArray(value);
		let desc = "";
		let previewText = "";
		if (Array.isArray(value)) {
			const arr = value as string[];
			previewText = property === "tags" ? arr.map((v) => `#${v}`).join(", ") : arr.join(", ");
		} else if (value !== undefined) previewText = String(value);
		if (previewText.length > 120) previewText = previewText.slice(0, 120) + "…";
		if (isClear) {
			const warn = modal.contentEl.createDiv({ cls: "mc-batch-modal-warn" });
			setIcon(warn.createSpan({ cls: "mc-batch-modal-warn-icon" }), "triangle-alert");
			warn.appendText(` The property '${property}' will be cleared (deleted) from all ${count} selected files. This cannot be undone.`);
		} else {
			if (operation === "replace") {
				desc = isList ? `Replace all values of '${property}' with ${previewText || "(empty)"} in ${count} files. Existing values will be overwritten.` : `Replace '${property}' with "${previewText}" in ${count} files.`;
			} else if (operation === "append") {
				desc = `Add ${previewText} to existing '${property}' in ${count} files. New values will be appended, duplicates are ignored.`;
			} else if (operation === "remove") {
				desc = `Remove ${previewText} from '${property}' in ${count} files.`;
			} else if (operation === "fill") {
				desc = isList ? `Fill empty '${property}' with ${previewText} in ${count} files. Only files where '${property}' is empty will be changed.` : `Fill empty '${property}' with "${previewText}" in ${count} files. Only empty properties will be changed.`;
			}
			const descEl = modal.contentEl.createDiv({ cls: "mc-batch-modal-desc" });
			descEl.setText(desc);
			const preview = modal.contentEl.createDiv({ cls: "mc-batch-modal-preview" });
			const opCls = isClear || operation === "remove" ? "mc-batch-op-red" : isReplace ? "mc-batch-op-orange" : "mc-batch-op-blue";
			preview.createSpan({ cls: `mc-batch-modal-op ${opCls}`, text: opLabel });
			preview.appendText(` ${property} → `);
			let text = previewText;
			if (operation === "append") text = `+ ${text}`;
			if (operation === "remove") text = `− ${text}`;
			if (operation === "fill") text = `∅ → ${text}`;
			preview.createSpan({ cls: "mc-batch-modal-value", text });
		}
		const listWrap = modal.contentEl.createDiv({ cls: "mc-batch-modal-files" });
		listWrap.createEl("div", { cls: "mc-batch-modal-files-title", text: `${count} files:` });
		const ul = listWrap.createEl("ul", { cls: "mc-batch-modal-files-list" });
		const show = Math.min(5, selectedPaths.length);
		for (let i = 0; i < show; i++) {
			ul.createEl("li", { text: getBasename(selectedPaths[i]) });
		}
		if (selectedPaths.length > show) {
			const more = listWrap.createEl("a", { cls: "mc-batch-modal-more", text: `and ${selectedPaths.length - show} more…` });
			more.addEventListener("click", (e) => {
				e.preventDefault();
				ul.empty();
				for (const p of selectedPaths) ul.createEl("li", { text: getBasename(p) });
				more.remove();
			});
		}
		const btns = modal.contentEl.createDiv({ cls: "modal-button-container" });
		const cancel = btns.createEl("button", { text: "Cancel" });
		const isRemove = operation === "remove";
		const btnCls = isClear || isRemove ? "mod-warning" : isReplace ? "mc-batch-apply-orange" : "mod-cta";
		const ok = btns.createEl("button", { text: "Apply", cls: btnCls });
		let settled = false;
		const doResolve = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
		cancel.addEventListener("click", () => { doResolve(false); modal.close(); });
		ok.addEventListener("click", () => { doResolve(true); modal.close(); });
		modal.onClose = () => { doResolve(false); onFocusReturn(); };
		modal.open();
	});
}
