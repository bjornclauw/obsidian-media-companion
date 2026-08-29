import { BasesView, Keymap, Menu, Notice, parsePropertyId, TFolder, setIcon, type BasesPropertyId, type QueryController, type HoverParent, type HoverPopover, type TFile, type BasesEntry, type WorkspaceLeaf } from "obsidian";
import { isListValue, resolvePropertyId, toDisplayValue, valuesEqual } from "./waterfall-batch";
import { confirmBatchModal } from "./waterfall-batch-modal";
import Sidecar from "../model/sidecar";
import { getMediaType, MediaTypes } from "../model/types/mediaTypes";
import { getShape } from "../model/types/shape";
import { hexToRgb, rgbToHsl, isColorWithinThreshold } from "../util/color";
import { VIEW_TYPE_SIDECAR } from "./sidecar-view";
import type { MediaCompanionSettings } from "../settings";

export const BASES_VIEW_TYPE_WATERFALL = "mc-waterfall";

const LABEL_HEIGHT = 24;
const BUFFER_PX = 800;
const PADDING = 8;

interface LayoutItem {
	mediaFile: TFile;
	sidecarFile: TFile | null;
	entry: BasesEntry | null;
	metaWidth: number;
	metaHeight: number;
	colors: { h: number; s: number; l: number; area: number }[] | null;

	col: number;
	x: number;
	y: number;

	itemHeight: number;
	measured: boolean;
	propsMeasured: boolean;
	propsHeight: number;
	el: HTMLElement | null;
}

/**
 * A Bases view that renders media in a waterfall (masonry) layout using
 * absolute positioning with virtual scrolling.
 */
export class WaterfallBasesView extends BasesView implements HoverParent {
	readonly type = BASES_VIEW_TYPE_WATERFALL;
	hoverPopover: HoverPopover | null = null;

	private scrollEl!: HTMLElement;
	private containerEl!: HTMLElement;
	private resizeObserver!: ResizeObserver;

	private layoutItems: LayoutItem[] = [];
	private columnHeights: number[] = [];
	private numColumns = 1;
	private colWidthSetting = 200;
	private gap = 8;
	private showFilename = true;
	private showProperties = false;

	private actualColWidth = 200;
	private offsetX = 0;
	private rafId: number | null = null;

	private hoverTimer: ReturnType<typeof setTimeout> | null = null;
	private fullscreenOverlay: HTMLElement | null = null;
	private fullscreenItem: LayoutItem | null = null;
	private settingsChangedRef: (() => void) | null = null;
	private getPluginSettings: () => MediaCompanionSettings;

	private lastDataFingerprint = "";
	private lastShowFilename = true;
	private lastShowProperties = false;
	private visibleProperties: BasesPropertyId[] = [];
	private lastPropsFingerprint = "";

	// Batch selection (Ctrl/Cmd + Shift, no checkboxes)
	private selected: Set<string> = new Set();
	private lastSelectedIndex: number | null = null;
	private batchBarEl!: HTMLElement;
	private batchCountEl!: HTMLElement;
	private batchPropertyInput!: HTMLInputElement;
	private batchOperationSelect!: HTMLSelectElement;
	private batchValueInput!: HTMLInputElement;
	private batchClearLabel!: HTMLElement;
	private batchPropertyClearBtn!: HTMLElement;
	private batchPropertyDropBtn!: HTMLElement;
	private pendingWritten = new Map<string, { property: string; value: unknown }>();

	private pendingKey(path: string, property: string): string { return `${path}\0${property}`; }

	constructor(controller: QueryController, parentEl: HTMLElement, getPluginSettings: () => MediaCompanionSettings) {
		super(controller);
		this.getPluginSettings = getPluginSettings;

		// Batch bar sits above scroll, stays visible (not virtual-scrolled away)
		this.batchBarEl = parentEl.createDiv({ cls: "mc-waterfall-batch-bar" });
		this.batchBarEl.style.display = "none";
		// Prevent Bases view from stealing focus when interacting with batch inputs
		this.batchBarEl.addEventListener("mousedown", (e) => e.stopPropagation());
		this.batchBarEl.addEventListener("click", (e) => e.stopPropagation());
		this.batchCountEl = this.batchBarEl.createSpan({ cls: "mc-batch-count", text: "0 selected" });
		const propWrap = this.batchBarEl.createDiv({ cls: "mc-batch-property-wrap" });
		this.batchPropertyInput = propWrap.createEl("input", { cls: "mc-batch-property", attr: { placeholder: "Property (e.g. tags)", type: "text", "aria-label": "Property name" } }) as HTMLInputElement;
		this.batchPropertyClearBtn = propWrap.createEl("button", { cls: "mc-batch-property-clear", attr: { "aria-label": "Clear property", "data-tooltip-position": "top" } });
		setIcon(this.batchPropertyClearBtn, "x");
		this.batchPropertyClearBtn.addEventListener("mousedown", (e) => e.stopPropagation());
		this.batchPropertyClearBtn.addEventListener("click", (e) => { e.stopPropagation(); this.batchPropertyInput.value = ""; this.updateBatchBar(); this.batchPropertyInput.focus(); });
		this.batchPropertyDropBtn = propWrap.createEl("button", { cls: "mc-batch-property-drop", attr: { "aria-label": "Show properties", "data-tooltip-position": "top" } });
		setIcon(this.batchPropertyDropBtn, "chevron-down");
		this.batchPropertyDropBtn.addEventListener("mousedown", (e) => e.stopPropagation());
		this.batchPropertyDropBtn.addEventListener("click", (e) => { e.stopPropagation(); this.batchPropertyInput.focus(); this.batchPropertyInput.showPicker?.(); });
		this.batchOperationSelect = this.batchBarEl.createEl("select", { cls: "mc-batch-operation", attr: { "aria-label": "Batch operation" } }) as HTMLSelectElement;
		this.batchValueInput = this.batchBarEl.createEl("input", { cls: "mc-batch-value", attr: { placeholder: "Value", type: "text", "aria-label": "Property value" } }) as HTMLInputElement;
		this.batchClearLabel = this.batchBarEl.createDiv({ cls: "mc-batch-clear-label", text: "the property will be cleared" });
		this.batchClearLabel.style.display = "none";
		for (const inp of [this.batchPropertyInput, this.batchValueInput]) {
			inp.addEventListener("mousedown", (e) => e.stopPropagation());
			inp.addEventListener("click", (e) => e.stopPropagation());
			inp.addEventListener("keydown", (e) => e.stopPropagation());
			inp.addEventListener("focus", (e) => e.stopPropagation());
		}
		this.batchOperationSelect.addEventListener("mousedown", (e) => e.stopPropagation());
		this.batchOperationSelect.addEventListener("click", (e) => e.stopPropagation());
		this.batchOperationSelect.addEventListener("change", () => this.updateBatchBar());
		this.batchPropertyInput.addEventListener("input", () => this.updateBatchBar());
		this.batchPropertyInput.addEventListener("change", () => this.updateBatchBar());
		const replaceBtn = this.batchBarEl.createEl("button", { cls: "mc-batch-replace", text: "Apply" });
		const clearBtn = this.batchBarEl.createEl("button", { cls: "mc-batch-clear", text: "Clear" });
		replaceBtn.addEventListener("click", () => void this.executeBatch());
		clearBtn.addEventListener("click", () => this.clearSelection());
		// Allow free-text property; datalist from visible order when available
		this.batchPropertyInput.setAttribute("list", "mc-batch-props");
		const dl = this.batchBarEl.createEl("datalist", { attr: { id: "mc-batch-props" } });

		this.scrollEl = parentEl.createDiv({ cls: "mc-waterfall-scroll" });
		this.containerEl = this.scrollEl.createDiv({ cls: "mc-waterfall-container" });

		this.scrollEl.addEventListener("scroll", () => this.scheduleSync(), { passive: true });
		this.scrollEl.addEventListener("keydown", (e) => { if (e.key === "Escape") this.clearSelection(); });

		this.resizeObserver = new ResizeObserver(() => {
			this.relayoutInPlace();
		});
		this.resizeObserver.observe(this.scrollEl);

		this.settingsChangedRef = () => this.refreshVisibleItems();
		this.app.workspace.on("mc:settings-changed" as any, this.settingsChangedRef);
	}

	private scheduleSync(): void {
		if (this.rafId !== null) return;
		this.rafId = requestAnimationFrame(() => {
			this.rafId = null;
			this.syncDOM();
		});
	}

	public onDataUpdated(): void {
		const newColWidth = Number(this.config.get("columnWidth")) || 200;
		const newGap = Number(this.config.get("gap")) || 8;
		const newShowFilename = this.config.get("showFilename") !== false;
		const newShowProperties = this.config.get("showProperties") === true;

		const newVisibleProperties = this.config.getOrder().filter(pid => {
			const parsed = parsePropertyId(pid);
			
			return !(parsed.type === "file" && parsed.name === "fileName");
		});
		const newPropsFingerprint = newVisibleProperties.join(",");
		this.visibleProperties = newVisibleProperties;

		const filterColor = String(this.config.get("filterColor") || "").trim();
		const colorThreshold = Number(this.config.get("colorThreshold")) || 50;
		const filterShape = String(this.config.get("filterShape") || "").trim().toLowerCase();
		const filterMinWidth = parseInt(String(this.config.get("filterMinWidth") || ""), 10) || 0;
		const filterMaxWidth = parseInt(String(this.config.get("filterMaxWidth") || ""), 10) || 0;
		const filterMinHeight = parseInt(String(this.config.get("filterMinHeight") || ""), 10) || 0;
		const filterMaxHeight = parseInt(String(this.config.get("filterMaxHeight") || ""), 10) || 0;
		const searchQuery = String(this.config.get("searchQuery") || "").trim().toLowerCase();

		const dataIds = this.data.groupedData.flatMap(g => g.entries.map(e => e.file.path)).join("\n");
		const fingerprint = `${dataIds}|${filterColor}|${colorThreshold}|${filterShape}|${filterMinWidth}|${filterMaxWidth}|${filterMinHeight}|${filterMaxHeight}|${searchQuery}`;

		const layoutOnly = fingerprint === this.lastDataFingerprint && this.layoutItems.length > 0;

		this.colWidthSetting = newColWidth;
		this.gap = newGap;
		this.showFilename = newShowFilename;
		this.showProperties = newShowProperties;

		if (layoutOnly) {
			if (newShowFilename !== this.lastShowFilename) {
				const delta = newShowFilename ? LABEL_HEIGHT : -LABEL_HEIGHT;

				for (const item of this.layoutItems) {
					item.itemHeight += delta;
				}
				
				for (const item of this.layoutItems) {
					if (!item.el) continue;
					
					const existing = item.el.querySelector(".mc-waterfall-name");
					
					if (newShowFilename && !existing) {
						const propsEl = item.el.querySelector(".mc-waterfall-props");
						const nameEl = createDiv({ cls: "mc-waterfall-name", text: item.mediaFile.basename });
						
						if (propsEl) {
							item.el.insertBefore(nameEl, propsEl);
						} else {
							item.el.appendChild(nameEl);
						}
					} else if (!newShowFilename && existing) {
						existing.remove();
					}
				}
			}
			this.lastShowFilename = newShowFilename;

			const propsToggled = newShowProperties !== this.lastShowProperties;
			const propsListChanged = newPropsFingerprint !== this.lastPropsFingerprint;

			if (propsToggled || (newShowProperties && propsListChanged)) {
				// Reset props measurement and re-render on mounted items.
				for (const item of this.layoutItems) {
					// Subtract old props height from the item before resetting
					if (item.propsHeight > 0) {
						item.itemHeight -= item.propsHeight;
					}
					item.propsMeasured = false;
					item.propsHeight = 0;

					if (!item.el) continue;
					
					const existing = item.el.querySelector(".mc-waterfall-props");
					if (existing) existing.remove();

					if (newShowProperties && this.visibleProperties.length > 0) {
						if (item.entry) this.renderProperties(item.el, item.entry);
					}
				}

				// Recompute positions with the props height stripped, then
				// measure newly rendered props and grow items to fit.
				this.relayoutInPlace(true, true);

				if (newShowProperties && this.visibleProperties.length > 0) {
					this.measureMountedProps();
				}
			} else {
				this.relayoutInPlace(true, true);
			}
			
			this.lastShowProperties = newShowProperties;
			this.lastPropsFingerprint = newPropsFingerprint;

			return;
		}

		this.lastDataFingerprint = fingerprint;
		this.lastShowFilename = newShowFilename;
		this.lastShowProperties = newShowProperties;
		this.lastPropsFingerprint = newPropsFingerprint;

		let targetHsl: [number, number, number] | null = null;
		
		if (filterColor) {
			const rgb = hexToRgb(filterColor);
			
			if (rgb) targetHsl = rgbToHsl(rgb[0], rgb[1], rgb[2]);
		}

		this.clearDOM();
		this.layoutItems = [];

		const seenMediaPaths = new Set<string>();
		const itemByMediaPath = new Map<string, LayoutItem>();
		const foldersInResult = new Set<string>();
		let deduplicatedCount = 0;

		for (const group of this.data.groupedData) {
			for (const entry of group.entries) {
				const resolved = this.resolveMediaFile(entry.file);
				if (!resolved) continue;

				const { mediaFile, sidecarFile } = resolved;

				if (mediaFile.parent) foldersInResult.add(mediaFile.parent.path);

				if (seenMediaPaths.has(mediaFile.path)) {
					// Prefer the sidecar-backed entry so properties are available
					if (entry.file.path.endsWith(Sidecar.EXTENSION)) {
						const existing = itemByMediaPath.get(mediaFile.path);
						if (existing) {
							existing.sidecarFile = sidecarFile;
							existing.entry = entry;
						}
					}
					deduplicatedCount++;
					continue;
				}
				seenMediaPaths.add(mediaFile.path);

				const meta = this.readSidecarMeta(sidecarFile);

				if (searchQuery && !mediaFile.path.toLowerCase().includes(searchQuery)) continue;
				if (filterShape && meta.width > 0 && meta.height > 0 && getShape(meta.width, meta.height) !== filterShape) continue;
				if (filterMinWidth > 0 && meta.width > 0 && meta.width < filterMinWidth) continue;
				if (filterMaxWidth > 0 && meta.width > 0 && meta.width > filterMaxWidth) continue;
				if (filterMinHeight > 0 && meta.height > 0 && meta.height < filterMinHeight) continue;
				if (filterMaxHeight > 0 && meta.height > 0 && meta.height > filterMaxHeight) continue;

				if (targetHsl && meta.colors) {
					if (!isColorWithinThreshold(targetHsl[0], targetHsl[1], targetHsl[2], meta.colors, colorThreshold / 100)) continue;
				}

				const item: LayoutItem = {
					mediaFile, sidecarFile, entry,
					metaWidth: meta.width, metaHeight: meta.height,
					colors: meta.colors,
					col: 0, x: 0, y: 0, itemHeight: 0,
					measured: false, propsMeasured: false, propsHeight: 0, el: null,
				};
				this.layoutItems.push(item);
				itemByMediaPath.set(mediaFile.path, item);
			}
		}

		// When the Bases limit counted both a media file and its sidecar as separate entries, 
		// our dedup reduced the visible count. Fill the remainder by scanning the vault for
		// additional sidecar-backed media files in the same folders.
		if (deduplicatedCount > 0) {
			let remaining = deduplicatedCount;
			
			for (const folderPath of foldersInResult) {
				if (remaining <= 0) break;
				
				const folder = this.app.vault.getAbstractFileByPath(folderPath);
				
				if (!(folder instanceof TFolder)) continue;
				
				for (const child of folder.children) {
					if (remaining <= 0) break;
					
					if (!child.path.endsWith(Sidecar.EXTENSION)) continue;
					
					const mediaPath = child.path.slice(0, -Sidecar.EXTENSION.length);
					
					if (seenMediaPaths.has(mediaPath)) continue;
					
					const sidecarFile = this.app.vault.getFileByPath(child.path);
					
					if (!sidecarFile) continue;
					
					const mediaFile = this.app.vault.getFileByPath(mediaPath);
					
					if (!mediaFile) continue;

					seenMediaPaths.add(mediaPath);
					const meta = this.readSidecarMeta(sidecarFile);

					if (searchQuery && !mediaFile.path.toLowerCase().includes(searchQuery)) continue;
					if (filterShape && meta.width > 0 && meta.height > 0 && getShape(meta.width, meta.height) !== filterShape) continue;
					if (filterMinWidth > 0 && meta.width > 0 && meta.width < filterMinWidth) continue;
					if (filterMaxWidth > 0 && meta.width > 0 && meta.width > filterMaxWidth) continue;
					if (filterMinHeight > 0 && meta.height > 0 && meta.height < filterMinHeight) continue;
					if (filterMaxHeight > 0 && meta.height > 0 && meta.height > filterMaxHeight) continue;
					if (targetHsl && meta.colors) {
						if (!isColorWithinThreshold(targetHsl[0], targetHsl[1], targetHsl[2], meta.colors, colorThreshold / 100)) continue;
					}

					this.layoutItems.push({
						mediaFile, sidecarFile, entry: null,
						metaWidth: meta.width, metaHeight: meta.height,
						colors: meta.colors,
						col: 0, x: 0, y: 0, itemHeight: 0,
						measured: false, propsMeasured: false, propsHeight: 0, el: null,
					});
					remaining--;
				}
			}
		}

		if (this.layoutItems.length === 0) {
			this.containerEl.style.height = "";
			
			this.containerEl.createDiv({
				cls: "mc-waterfall-empty",
				text: "No media files found. Make sure your Base queries sidecar (.sidecar.md) files or supported media files.",
			});
			
			return;
		}

		this.computePositions();
		// Prune selection for items filtered out, keep bar in sync
		if (this.selected.size > 0) {
			const stillValid = new Set(this.layoutItems.map((i) => i.mediaFile.path));
			for (const p of Array.from(this.selected)) {
				if (!stillValid.has(p)) this.selected.delete(p);
			}
			this.updateBatchBar();
		} else {
			this.updateBatchBar();
		}
		// If Bases just delivered fresh entries that match our pending optimistic values, drop pending
		if (this.pendingWritten.size > 0) {
			for (const [key, pending] of Array.from(this.pendingWritten.entries())) {
				const path = key.split("\0")[0];
				const it = this.layoutItems.find((i) => i.mediaFile.path === path);
				if (!it?.entry) continue;
				try {
					const pid = resolvePropertyId(pending.property, this.visibleProperties);
					if (!pid) { this.pendingWritten.delete(key); continue; }
					const cur = this.getBasesValue(it, pid);
					if (valuesEqual(pending.property, pending.value, cur)) this.pendingWritten.delete(key);
				} catch {}
			}
		}
		this.syncDOM();
	}

	private get footerHeight(): number {
		let h = 0;
		if (this.showFilename) h += LABEL_HEIGHT;
		return h;
	}

	private computePositions(): void {
		const clientW = this.scrollEl.clientWidth || 400;
		const available = clientW - PADDING * 2;
		
		this.numColumns = Math.max(1, Math.floor((available + this.gap) / (this.colWidthSetting + this.gap)));
		this.actualColWidth = (available - (this.numColumns - 1) * this.gap) / this.numColumns;

		const totalUsed = this.numColumns * this.actualColWidth + (this.numColumns - 1) * this.gap;
		
		this.offsetX = (clientW - totalUsed) / 2;
		this.columnHeights = new Array(this.numColumns).fill(PADDING);

		for (const item of this.layoutItems) {
			const col = this.shortestColumn();
			
			item.col = col;
			item.x = this.offsetX + col * (this.actualColWidth + this.gap);
			item.y = this.columnHeights[col];

			if (!item.measured) {
				const mediaH = item.metaWidth > 0 && item.metaHeight > 0
					? (this.actualColWidth / item.metaWidth) * item.metaHeight
					: this.actualColWidth; // square fallback
				item.itemHeight = mediaH + this.footerHeight + item.propsHeight;
			}
			this.columnHeights[col] += item.itemHeight + this.gap;
		}

		this.containerEl.style.height = `${Math.max(0, ...this.columnHeights)}px`;
	}

	private shortestColumn(): number {
		let min = 0;
		for (let i = 1; i < this.numColumns; i++) {
			if (this.columnHeights[i] < this.columnHeights[min]) min = i;
		}
		return min;
	}

	private relayoutInPlace(force = false, animate = false): void {
		if (this.layoutItems.length === 0) return;

		const oldColWidth = this.actualColWidth;
		const available = (this.scrollEl.clientWidth || 400) - PADDING * 2;
		const newNumCols = Math.max(1, Math.floor((available + this.gap) / (this.colWidthSetting + this.gap)));
		const newColWidth = (available - (newNumCols - 1) * this.gap) / newNumCols;

		if (!force && newNumCols === this.numColumns && Math.abs(newColWidth - oldColWidth) < 0.5) return;

		// Suppress animated transitions during resize so the relayout is instant,
		// but keep them when the caller explicitly requests animation (e.g. toggling props).
		if (!animate) {
			this.containerEl.classList.add("mc-no-transition");
		}

		const scale = newColWidth / (oldColWidth || 1);

		for (const item of this.layoutItems) {
			if (item.measured) {
				const footer = this.footerHeight + item.propsHeight;
				
				item.itemHeight = (item.itemHeight - footer) * scale + footer;
			}
		}

		this.computePositions();

		for (const item of this.layoutItems) {
			if (!item.el) continue;
			
			item.el.style.top = `${item.y}px`;
			item.el.style.left = `${item.x}px`;
			item.el.style.width = `${this.actualColWidth}px`;
			item.el.style.height = `${item.itemHeight}px`;
		}

		this.syncDOM();

		// Re-enable transitions after the browser has painted the new positions.
		if (!animate) {
			requestAnimationFrame(() => {
				this.containerEl.classList.remove("mc-no-transition");
			});
		}
	}

	private reflowColumn(changed: LayoutItem, newHeight: number): void {
		const delta = newHeight - changed.itemHeight;
		if (Math.abs(delta) < 1) return;

		changed.itemHeight = newHeight;
		if (changed.el) changed.el.style.height = `${newHeight}px`;

		const col = changed.col;
		let past = false;

		for (const item of this.layoutItems) {
			if (item === changed) { past = true; continue; }
			if (!past || item.col !== col) continue;
			
			item.y += delta;
			
			if (item.el) item.el.style.top = `${item.y}px`;
		}

		this.columnHeights[col] += delta;
		this.containerEl.style.height = `${Math.max(0, ...this.columnHeights)}px`;

		this.syncDOM();
	}

	/**
	 * Measure the rendered props height of all mounted items that haven't
	 * been measured yet, and grow them to fit.  Used after toggling props on
	 * so the layout adjusts to the new content.
	 */
	private measureMountedProps(): void {
		requestAnimationFrame(() => {
			for (const item of this.layoutItems) {
				if (item.propsMeasured || !item.el) continue;
				const propsEl = item.el.querySelector(".mc-waterfall-props") as HTMLElement | null;
				const propsH = propsEl ? propsEl.offsetHeight : 0;
				item.propsMeasured = true;
				item.propsHeight = propsH;
				if (propsH > 0) {
					const newH = item.itemHeight + propsH;
					item.el.style.height = `${newH}px`;
					this.reflowColumn(item, newH);
				}
			}
		});
	}

	private syncDOM(): void {
		const scrollTop = this.scrollEl.scrollTop;
		const viewHeight = this.scrollEl.clientHeight;
		const top = scrollTop - BUFFER_PX;
		const bottom = scrollTop + viewHeight + BUFFER_PX;

		for (const item of this.layoutItems) {
			const inView = item.y + item.itemHeight > top && item.y < bottom;

			if (inView && !item.el) {
				this.mountItem(item);
			} else if (!inView && item.el) {
				item.el.remove();
				item.el = null;
			}
		}
	}

	private clearDOM(): void {
		for (const item of this.layoutItems) {
			if (item.el) { item.el.remove(); item.el = null; }
		}
		
		this.containerEl.empty();
	}

	private mountItem(item: LayoutItem): void {
		const el = this.containerEl.createDiv({ cls: "mc-waterfall-item" });
		item.el = el;
		el.setAttr("role", "button");
		el.setAttr("tabIndex", "0");
		el.setAttr("aria-label", item.mediaFile.basename);
		el.setAttr("data-tooltip-position", "top");

		el.style.top = `${item.y}px`;
		el.style.left = `${item.x}px`;
		el.style.width = `${this.actualColWidth}px`;
		el.style.height = `${item.itemHeight}px`;

		const mc = el.createDiv({ cls: "mc-waterfall-media" });
		const mediaH = item.itemHeight - this.footerHeight;
		const ph = mc.createDiv({ cls: "mc-waterfall-placeholder" });
		
		ph.style.height = `${Math.max(mediaH, 50)}px`;

		this.loadMediaContent(item, el, mc);

		// Read fullscreen settings fresh from the plugin each time an item is mounted
		// so that changes in plugin settings take effect without a full re-render.
		const { fullscreenMode: fsMode, fullscreenHoverDelay: fsDelay } = this.getPluginSettings();

		if (fsMode !== "off") {
			const btn = mc.createDiv({ cls: "mc-waterfall-fullscreen-btn", attr: { "aria-label": "Expand", "data-tooltip-position": "top", "role": "button", "tabIndex": "0" } });
			setIcon(btn, "zoom-in");

			if (fsMode === "hover") {
				btn.addEventListener("mouseenter", () => {
					this.clearHoverTimer();
					this.hoverTimer = setTimeout(() => {
						this.showFullscreen(item);
					}, fsDelay);
				});
				btn.addEventListener("mouseleave", () => {
					this.clearHoverTimer();
				});
			}

			btn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.showFullscreen(item);
			});
			btn.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter" || evt.key === " ") { evt.preventDefault(); evt.stopPropagation(); this.showFullscreen(item); }
			});
		}

		if (this.showFilename) {
			el.createDiv({ cls: "mc-waterfall-name", text: item.mediaFile.basename });
		}

		if (this.showProperties && this.visibleProperties.length > 0) {
			// Check if any pending for this item among visibleProperties
			let hasPending = false;
			for (const pid of this.visibleProperties) {
				const n = parsePropertyId(pid).name;
				if (this.pendingWritten.has(this.pendingKey(item.mediaFile.path, n))) { hasPending = true; break; }
			}
			if (hasPending) {
				const fakeEntry = {
					getValue: (pid: BasesPropertyId) => {
						const n = parsePropertyId(pid).name;
						const pend = this.pendingWritten.get(this.pendingKey(item.mediaFile.path, n));
						if (pend) return toDisplayValue(n, pend.value) as any;
						return this.getBasesValue(item, pid) as any;
					},
				} as unknown as BasesEntry;
				this.renderProperties(el, fakeEntry);
			} else if (item.entry) this.renderProperties(el, item.entry);
		}

		// The pre-calculated itemHeight covers media + filename only.
		// Measure the actual rendered props height (which may wrap) and
		// grow the item to fit.
		if (!item.propsMeasured && this.showProperties && this.visibleProperties.length > 0) {
			// Allow overflow so the props are laid out at their natural
			// height even though the explicit item height is too short.
			el.style.overflow = "visible";
			requestAnimationFrame(() => {
				if (!item.el || item.propsMeasured) return;
				const propsEl = item.el.querySelector(".mc-waterfall-props") as HTMLElement | null;
				const propsH = propsEl ? propsEl.offsetHeight : 0;
				item.propsMeasured = true;
				item.propsHeight = propsH;
				item.el.style.overflow = "";
				if (propsH > 0) {
					const newH = item.itemHeight + propsH;
					item.el.style.height = `${newH}px`;
					this.reflowColumn(item, newH);
				}
			});
		}

		el.setAttribute("draggable", "true");
		el.addEventListener("dragstart", (evt) => {
			if (!evt.dataTransfer) return;
			
			const resourcePath = this.app.vault.getResourcePath(item.mediaFile);
			evt.dataTransfer.setData("text/uri-list", resourcePath);
			evt.dataTransfer.setData("text/plain", item.mediaFile.path);
			evt.dataTransfer.effectAllowed = "copy";

			const img = el.querySelector("img");
			
			if (img) evt.dataTransfer.setDragImage(img, 0, 0);
		});

		el.addEventListener("contextmenu", (evt) => {
			evt.preventDefault();
			const menu = new Menu();

			menu.addItem((mi) =>
				mi.setTitle("Copy")
					.setIcon("copy")
					.onClick(() => void this.copyMediaToClipboard(item.mediaFile))
			);

			menu.addItem((mi) =>
				mi.setTitle("Delete")
					.setIcon("trash")
					.onClick(() => void this.deleteMediaFile(item))
			);

			menu.showAtMouseEvent(evt);
		});

		// Apply selection outline for virtualized remounts
		if (this.selected.has(item.mediaFile.path)) el.addClass("mc-selected");

		el.addEventListener("click", (evt) => {
			if (evt.button !== 0 && evt.button !== 1) return;
			evt.preventDefault();

			const idx = this.layoutItems.indexOf(item);
			const isCtrlCmd = Keymap.isModEvent(evt) || (evt as MouseEvent).ctrlKey || (evt as MouseEvent).metaKey;
			const isShift = (evt as MouseEvent).shiftKey;

			if (isShift && this.lastSelectedIndex !== null) {
				const start = Math.min(this.lastSelectedIndex, idx);
				const end = Math.max(this.lastSelectedIndex, idx);
				for (let i = start; i <= end; i++) {
					this.selected.add(this.layoutItems[i].mediaFile.path);
					if (this.layoutItems[i].el) this.layoutItems[i].el!.addClass("mc-selected");
				}
				this.updateBatchBar();
				return;
			}
			if (isCtrlCmd) {
				if (this.selected.has(item.mediaFile.path)) {
					this.selected.delete(item.mediaFile.path);
					el.removeClass("mc-selected");
				} else {
					this.selected.add(item.mediaFile.path);
					el.addClass("mc-selected");
				}
				this.lastSelectedIndex = idx;
				this.updateBatchBar();
				return;
			}
			// Plain click: if selection exists, clear it first (avoid opening while selecting)
			if (this.selected.size > 0) {
				this.clearSelection();
			}
			this.lastSelectedIndex = idx;
			if (Keymap.isModEvent(evt)) {
				const newLeaf = this.app.workspace.getLeaf("tab");
				void newLeaf.setViewState({
					type: VIEW_TYPE_SIDECAR,
					state: { file: item.mediaFile.path },
				});
				this.app.workspace.setActiveLeaf(newLeaf, { focus: true });
			} else {
				void this.openInSidebar(item.mediaFile);
			}
		});
		el.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter" || evt.key === " ") {
				evt.preventDefault();
				void this.openInSidebar(item.mediaFile);
			}
		});

	}

	private loadMediaContent(item: LayoutItem, el: HTMLElement, mc: HTMLElement): void {
		const resourcePath = this.app.vault.getResourcePath(item.mediaFile);
		const mediaType = getMediaType(item.mediaFile.extension);

		const onSized = (naturalW: number, naturalH: number) => {
			const ph = mc.querySelector(".mc-waterfall-placeholder");
			
			if (ph) ph.remove();

			if (item.measured) return; // height already correct
			
			item.measured = true;

			const mediaH = naturalH * (this.actualColWidth / naturalW);
			let newH = mediaH + this.footerHeight;

			// If props were already measured, preserve that extra height.
			if (item.propsMeasured) {
				const propsEl = item.el?.querySelector(".mc-waterfall-props") as HTMLElement | null;
				if (propsEl) newH += propsEl.offsetHeight;
			}

			this.reflowColumn(item, newH);
		};

		if (mediaType === MediaTypes.Image) {
			const img = mc.createEl("img", {
				attr: { src: resourcePath, alt: item.mediaFile.basename },
			});

			img.addEventListener("load", () => onSized(img.naturalWidth, img.naturalHeight));
		} else if (mediaType === MediaTypes.Video) {
			const video = mc.createEl("video", {
				attr: { src: resourcePath, preload: "metadata", muted: "" },
			});

			video.addEventListener("mouseenter", () => { video.play().catch(() => {}); });
			video.addEventListener("mouseleave", () => { video.pause(); video.currentTime = 0; });
			video.addEventListener("loadedmetadata", () => onSized(video.videoWidth, video.videoHeight));
		} else {
			const embedCreator = this.app.embedRegistry.getEmbedCreator(item.mediaFile);
			
			if (embedCreator) {
				const embedEl = mc.createDiv();
				const embed = embedCreator({ app: this.app, containerEl: embedEl }, item.mediaFile, item.mediaFile.path);
				// @ts-ignore ÔÇô loadFile exists on embed components
				if (embed.loadFile) embed.loadFile();
			} else {
				mc.createDiv({ text: item.mediaFile.basename, cls: "mc-waterfall-name" });
			}
			
			item.measured = true;
			const ph = mc.querySelector(".mc-waterfall-placeholder");
			
			if (ph) ph.remove();
		}
	}

	private resolveMediaFile(file: TFile): { mediaFile: TFile; sidecarFile: TFile | null } | null {
		if (file.path.endsWith(Sidecar.EXTENSION)) {
			const mediaPath = file.path.slice(0, -Sidecar.EXTENSION.length);
			const mediaFile = this.app.vault.getFileByPath(mediaPath);
			
			return mediaFile ? { mediaFile, sidecarFile: file } : null;
		}

		const mediaType = getMediaType(file.extension);
		
		if (mediaType !== MediaTypes.Unknown) {
			const sidecarFile = this.app.vault.getFileByPath(`${file.path}${Sidecar.EXTENSION}`);
			
			return { mediaFile: file, sidecarFile };
		}

		return null;
	}

	private readSidecarMeta(sidecarFile: TFile | null): {
		width: number;
		height: number;
		colors: { h: number; s: number; l: number; area: number }[] | null;
	} {
		if (!sidecarFile) return { width: 0, height: 0, colors: null };

		const cache = this.app.metadataCache.getFileCache(sidecarFile);
		const fm = cache?.frontmatter;
		
		if (!fm) return { width: 0, height: 0, colors: null };

		let width = 0, height = 0;
		const size = fm["MC-size"];
		
		if (Array.isArray(size) && size.length === 2) {
			width = Number(size[0]) || 0;
			height = Number(size[1]) || 0;
		}

		let colors = null;
		const raw = fm["MC-colors"];
		
		if (Array.isArray(raw)) colors = raw as { h: number; s: number; l: number; area: number }[];

		return { width, height, colors };
	}

	private renderProperties(parentEl: HTMLElement, entry: BasesEntry): void {
		const propsEl = parentEl.createDiv({ cls: "mc-waterfall-props" });
		
		for (const pid of this.visibleProperties) {
			const val = entry.getValue(pid);
			const name = this.config.getDisplayName(pid);
			const propEl = propsEl.createDiv({ cls: "mc-waterfall-prop" });

			const nameSpan = propEl.createSpan({ cls: "mc-waterfall-prop-name" });
			nameSpan.textContent = `${name}: `;

			const valueSpan = propEl.createSpan({ cls: "mc-waterfall-prop-value" });
			this.renderPropertyValue(valueSpan, val);
		}
	}

	private renderPropertyValue(container: HTMLElement, val: unknown): void {
		if (val == null || val === "null" || val === "undefined") {
			container.appendText("-");
			return;
		}

		if (Array.isArray(val)) {
			if (val.length === 0) {
				container.appendText("-");
				return;
			}
			for (let i = 0; i < val.length; i++) {
				if (i > 0) container.appendText(", ");
				this.renderPropertyValue(container, val[i]);
			}
			return;
		}

		// Obsidian link objects have a `path` property
		if (typeof val === "object" && val !== null && "path" in val) {
			const linkObj = val as { path: string; display?: string };
			const a = container.createEl("a", {
				cls: "mc-prop-link",
				text: linkObj.display || linkObj.path.split("/").pop()?.replace(/\.[^.]+$/, "") || linkObj.path,
			});
			a.addEventListener("click", (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				this.app.workspace.openLinkText(linkObj.path, "", Keymap.isModEvent(evt));
			});
			return;
		}

		const text = String(val);

		if (text === "" || text === "null" || text === "undefined") {
			container.appendText("-");
			return;
		}

		// Wiki-links: [[Page]] or [[Page|Display]]
		const wikiLinkRegex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
		if (wikiLinkRegex.test(text)) {
			wikiLinkRegex.lastIndex = 0;
			let lastIndex = 0;
			let match;
			while ((match = wikiLinkRegex.exec(text)) !== null) {
				if (match.index > lastIndex) {
					container.appendText(text.slice(lastIndex, match.index));
				}
				const linkPath = match[1].trim();
				const display = match[2]?.trim() || linkPath.split("/").pop()?.replace(/\.[^.]+$/, "") || linkPath;
				const a = container.createEl("a", { cls: "mc-prop-link", text: display });
				a.addEventListener("click", (evt) => {
					evt.preventDefault();
					evt.stopPropagation();
					this.app.workspace.openLinkText(linkPath, "", Keymap.isModEvent(evt));
				});
				lastIndex = match.index + match[0].length;
			}
			if (lastIndex < text.length) {
				container.appendText(text.slice(lastIndex));
			}
			return;
		}

		// Tags: strings containing #tag tokens
		const tagRegex = /#[^\s#,]+/g;
		if (tagRegex.test(text)) {
			tagRegex.lastIndex = 0;
			let lastIndex = 0;
			let match;
			while ((match = tagRegex.exec(text)) !== null) {
				if (match.index > lastIndex) {
					container.appendText(text.slice(lastIndex, match.index));
				}
				const tagText = match[0];
				const tag = container.createSpan({ cls: "mc-prop-tag", text: tagText });
				tag.addEventListener("click", (evt) => {
					evt.preventDefault();
					evt.stopPropagation();
					// @ts-ignore ÔÇô global search for tag
					this.app.internalPlugins?.getPluginById?.("global-search")?.instance?.openGlobalSearch?.(`tag:${tagText}`);
				});
				lastIndex = match.index + match[0].length;
			}
			if (lastIndex < text.length) {
				container.appendText(text.slice(lastIndex));
			}
			return;
		}

		// URL strings
		if (text.startsWith("http://") || text.startsWith("https://")) {
			const a = container.createEl("a", { cls: "mc-prop-link", text });
			a.addEventListener("click", (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				window.open(text, "_blank");
			});
			return;
		}

		container.appendText(text);
	}

	private async copyMediaToClipboard(mediaFile: TFile): Promise<void> {
		try {
			const data = await this.app.vault.readBinary(mediaFile);
			const srcMime = this.getMimeType(mediaFile.extension);

			// The Clipboard API only supports image/png for writing.
			// If the source is already PNG, write directly; otherwise
			// draw onto a canvas and export as PNG.
			let pngBlob: Blob;
			if (srcMime === "image/png") {
				pngBlob = new Blob([data], { type: "image/png" });
			} else if (srcMime.startsWith("image/")) {
				pngBlob = await this.convertToPng(data, srcMime);
			} else {
				// Non-image files fall back to plain text path
				await navigator.clipboard.writeText(mediaFile.path);
				new Notice(`Copied path of ${mediaFile.basename} to clipboard`);
				return;
			}

			await navigator.clipboard.write([
				new ClipboardItem({ "image/png": pngBlob }),
			]);

			new Notice(`Copied ${mediaFile.basename} to clipboard`);

		} catch (e) {
			new Notice("Failed to copy media to clipboard");
		}
	}

	private convertToPng(data: ArrayBuffer, mimeType: string): Promise<Blob> {
		return new Promise((resolve, reject) => {
			const blob = new Blob([data], { type: mimeType });
			const url = URL.createObjectURL(blob);
			const img = new Image();
			
			img.onload = () => {
				const canvas = activeDocument.createElement("canvas");
				canvas.width = img.naturalWidth;
				canvas.height = img.naturalHeight;
				const ctx = canvas.getContext("2d");
				if (!ctx) { URL.revokeObjectURL(url); reject(new Error("Canvas 2D context unavailable")); return; }
				ctx.drawImage(img, 0, 0);
				canvas.toBlob((pngBlob) => {
					URL.revokeObjectURL(url);
					if (pngBlob) resolve(pngBlob);
					else reject(new Error("Canvas toBlob returned null"));
				}, "image/png");
			};
			
			img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Failed to load image for conversion")); };
			img.src = url;
		});
	}

	private async deleteMediaFile(item: LayoutItem): Promise<void> {
		try {
			// Trash the sidecar first (if it exists)
			if (item.sidecarFile) {
				await this.app.fileManager.trashFile(item.sidecarFile);
			}

			await this.app.fileManager.trashFile(item.mediaFile);

			if (item.el) { item.el.remove(); item.el = null; }

			this.layoutItems = this.layoutItems.filter(i => i !== item);
			this.computePositions();
			this.syncDOM();
		} catch (e) {
			new Notice("Failed to delete file");
		}
	}

	private getMimeType(ext: string): string {
		const map: Record<string, string> = {
			png: "image/png",
			jpg: "image/jpeg",
			jpeg: "image/jpeg",
			gif: "image/gif",
			webp: "image/webp",
			svg: "image/svg+xml",
			bmp: "image/bmp",
			mp4: "video/mp4",
			webm: "video/webm",
			ogv: "video/ogg",
		};
		return map[ext.toLowerCase()] || "application/octet-stream";
	}

	private clearHoverTimer(): void {
		if (this.hoverTimer !== null) {
			clearTimeout(this.hoverTimer);
			this.hoverTimer = null;
		}
	}

	private showFullscreen(item: LayoutItem): void {
		if (this.fullscreenOverlay) this.dismissFullscreen();

		const overlay = activeDocument.body.createDiv({ cls: "mc-waterfall-fullscreen" });
		this.fullscreenOverlay = overlay;
		this.fullscreenItem = item;

		const resourcePath = this.app.vault.getResourcePath(item.mediaFile);
		const mediaType = getMediaType(item.mediaFile.extension);

		if (mediaType === MediaTypes.Video) {
			const video = overlay.createEl("video", {
				cls: "mc-waterfall-fullscreen-media",
				attr: { src: resourcePath, autoplay: "", controls: "", muted: "" },
			});
			video.play().catch(() => {});
		} else {
			overlay.createEl("img", {
				cls: "mc-waterfall-fullscreen-media",
				attr: { src: resourcePath, alt: item.mediaFile.basename },
			});
		}

		if (this.showFilename) {
			overlay.createDiv({ cls: "mc-waterfall-fullscreen-label", text: item.mediaFile.basename });
		}

		overlay.addEventListener("click", () => this.dismissFullscreen());
		overlay.addEventListener("mouseleave", () => this.dismissFullscreen());

		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") this.dismissFullscreen();
		};
		activeDocument.addEventListener("keydown", onKey, { once: true });
	}

	private dismissFullscreen(): void {
		if (this.fullscreenOverlay) {
			this.fullscreenOverlay.remove();
			this.fullscreenOverlay = null;
			this.fullscreenItem = null;
		}
	}

	private async openInSidebar(mediaFile: TFile): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = null;

		for (const l of workspace.getLeavesOfType(VIEW_TYPE_SIDECAR)) {
			if (l.getRoot() === workspace.rightSplit) {
				leaf = l;
				break;
			}
		}

		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			if (!leaf) return;
		}

		await leaf.setViewState({
			type: VIEW_TYPE_SIDECAR,
			state: { file: mediaFile.path },
		});

		workspace.revealLeaf(leaf);
	}

	private isArrayProperty(property: string): boolean {
		if (property === "tags") return true;
		const pid = resolvePropertyId(property, this.visibleProperties);
		if (!pid) return false;
		for (const it of this.layoutItems) {
			try {
				const v = this.getBasesValue(it, pid);
				if (isListValue(v)) return true;
			} catch {}
		}
		return false;
	}

	private getBasesValue(item: LayoutItem, pid: BasesPropertyId): unknown {
		return (item.entry as unknown as { getValue: (pid: BasesPropertyId) => unknown })?.getValue?.(pid) ?? null;
	}

	private updateBatchBar(): void {
		const n = this.selected.size;
		this.batchCountEl.textContent = `${n} selected`;
		this.batchBarEl.style.display = n > 0 ? "flex" : "none";
		this.batchBarEl.style.pointerEvents = n > 0 ? "auto" : "none";
		this.batchPropertyInput.disabled = false;
		this.batchValueInput.disabled = false;
		this.batchPropertyInput.readOnly = false;
		this.batchValueInput.readOnly = false;
		this.batchPropertyInput.style.pointerEvents = "auto";
		this.batchValueInput.style.pointerEvents = "auto";
		const property = this.batchPropertyInput.value.trim();
		const hasText = property.length > 0;
		this.batchPropertyClearBtn.style.display = hasText ? "flex" : "none";
		this.batchPropertyDropBtn.style.display = hasText ? "none" : "flex";
		const isArray = property ? this.isArrayProperty(property) : false;
		{
			const currentOp = this.batchOperationSelect.value;
			this.batchOperationSelect.empty();
			if (!property || isArray) {
				for (const [v, t] of [["replace","Replace"],["append","Append"],["remove","Remove"],["fill","Fill empty"],["clear","Clear"]] as const) {
					this.batchOperationSelect.createEl("option", { attr: { value: v }, text: t });
				}
			} else {
				for (const [v, t] of [["replace","Replace"],["fill","Fill empty"],["clear","Clear"]] as const) {
					this.batchOperationSelect.createEl("option", { attr: { value: v }, text: t });
				}
			}
			if (Array.from(this.batchOperationSelect.options).some(o => o.value === currentOp)) this.batchOperationSelect.value = currentOp;
		}
		const op = this.batchOperationSelect.value;
		const isClear = op === "clear";
		this.batchValueInput.style.display = isClear ? "none" : "";
		this.batchClearLabel.style.display = isClear ? "" : "none";
		this.batchValueInput.placeholder = isArray ? "enter a value, or multiple separated by ," : "Enter a value";
		const dl = this.batchBarEl.querySelector("datalist#mc-batch-props") as HTMLDataListElement | null;
		if (dl) {
			dl.empty();
			if (this.visibleProperties.length > 0) {
				for (const pid of this.visibleProperties) {
					const parsed = parsePropertyId(pid);
					if (parsed.name) dl.createEl("option", { attr: { value: parsed.name } });
				}
			} else {
				for (const name of ["tags", "title", "description"]) dl.createEl("option", { attr: { value: name } });
			}
		}
		if (n === 0) {
			this.batchPropertyInput.value = "";
			this.batchValueInput.value = "";
			this.batchOperationSelect.value = "replace";
		}
	}

	private clearSelection(): void {
		for (const p of this.selected) {
			const it = this.layoutItems.find((i) => i.mediaFile.path === p);
			if (it?.el) it.el.removeClass("mc-selected");
		}
		this.selected.clear();
		this.lastSelectedIndex = null;
		this.updateBatchBar();
	}

	private async confirmBatch(count: number, property: string, value: unknown, operation: string): Promise<boolean> {
		const paths = Array.from(this.selected);
		return confirmBatchModal(this.app, count, property, value, operation, paths, (p) => this.layoutItems.find((x) => x.mediaFile.path === p)?.mediaFile.basename ?? p.split("/").pop() ?? p, () => {
			if (this.selected.size > 0 && this.batchBarEl.style.display !== "none") this.batchValueInput.focus();
		});
	}

	private async executeBatch(): Promise<void> {
		const property = this.batchPropertyInput.value.trim();
		const rawValue = this.batchValueInput.value.trim();
		const operation = this.batchOperationSelect.value || "replace";
		if (!property) { new Notice("Enter a property name"); return; }
		if (this.selected.size === 0) { new Notice("No files selected"); return; }
		const reserved = ["MC-size", "MC-colors", "MC-last-updated"];
		if (reserved.includes(property)) { new Notice(`Cannot batch-edit reserved property ${property}`); return; }
		const isArray = this.isArrayProperty(property);
		const isClear = operation === "clear";
		if (!isClear && !rawValue && operation !== "fill") {
			// Allow empty string for Replace on string props (creates empty property), but not for array ops without value
			if (isArray && operation !== "clear") { new Notice("Enter a value"); return; }
		}
		let value: unknown;
		let parsedValues: string[] = [];
		if (isClear) {
			value = undefined;
		} else if (isArray) {
			parsedValues = rawValue.split(",").map((s) => s.trim()).filter(Boolean);
			if (property === "tags") parsedValues = [...new Set(parsedValues.map((s) => s.toLowerCase()))];
			else parsedValues = [...new Set(parsedValues)];
			if (parsedValues.length === 0 && operation !== "clear") { new Notice("Enter a value"); return; }
			// For Replace we set array, for Append/Remove etc we need the list
			if (operation === "replace") value = parsedValues;
			else value = parsedValues;
		} else {
			// String property: rawValue as-is (empty string allowed for Replace)
			try {
				const parsed = JSON.parse(rawValue);
				if (typeof parsed === "number" || typeof parsed === "boolean") value = parsed;
				else value = rawValue;
			} catch { value = rawValue; }
		}
		const displayValue = isClear ? undefined : isArray && operation !== "replace" ? parsedValues : value;
		if (!await this.confirmBatch(this.selected.size, property, displayValue, operation)) return;
		const paths = Array.from(this.selected);
		const notice = new Notice(`Updating ${paths.length} files…`, 0);
		let done = 0, failed = 0;
		for (const p of paths) {
			const item = this.layoutItems.find((i) => i.mediaFile.path === p);
			if (!item) { failed++; continue; }
			let sidecarFile = item.sidecarFile;
			if (!sidecarFile) {
				sidecarFile = this.app.vault.getFileByPath(`${p}${Sidecar.EXTENSION}`) as TFile | null;
				if (!sidecarFile) {
					try { const created = await this.app.vault.create(`${p}${Sidecar.EXTENSION}`, ""); sidecarFile = created; item.sidecarFile = sidecarFile; } catch { failed++; continue; }
				} else item.sidecarFile = sidecarFile;
			}
			try {
				let finalForPending: unknown = undefined;
				await this.app.fileManager.processFrontMatter(sidecarFile, (fm: Record<string, unknown>) => {
					if (operation === "clear") { delete fm[property]; finalForPending = undefined; return; }
					if (isArray) {
						const curRaw = fm[property];
						let cur: string[] = Array.isArray(curRaw) ? curRaw.map((x: any) => String(x)) : curRaw != null && curRaw !== "" ? [String(curRaw)] : [];
						if (property === "tags") cur = cur.map((s) => s.toLowerCase());
						const vals = parsedValues;
						if (operation === "replace") { fm[property] = [...vals]; finalForPending = [...vals]; }
						else if (operation === "append") {
							const set = new Set(cur);
							for (const v of vals) if (!set.has(v)) cur.push(v);
							fm[property] = cur; finalForPending = [...cur];
						} else if (operation === "remove") {
							const rem = new Set(vals);
							const next = cur.filter((x) => !rem.has(x));
							fm[property] = next; finalForPending = [...next];
						} else if (operation === "fill") {
							if (cur.length === 0) { fm[property] = [...vals]; finalForPending = [...vals]; } else finalForPending = [...cur];
						}
					} else {
						const cur = fm[property];
						if (operation === "fill") {
							if (cur == null || cur === "") { fm[property] = value; finalForPending = value; }
							else finalForPending = cur;
						} else { fm[property] = value; finalForPending = value; }
					}
				});
				done++;
				this.pendingWritten.set(this.pendingKey(p, property), { property, value: finalForPending });
			} catch (e) { failed++; }
			notice.setMessage(`Media Companion: ${done}/${paths.length} updated${failed ? ` (${failed} failed)` : ""}`);
		}
		notice.hide();
		new Notice(`${done} files updated${failed ? ` — ${failed} failed` : ""}`);
		try { (this.app.workspace as unknown as { trigger: (name: string) => void }).trigger("mc:batch-updated"); } catch {}
		// Optimistic patch: update all affected tiles' prop DOM via fakeEntry that uses finalForPending,
		// and keep pendingWritten for off-screen cards so they render correctly when scrolled into view.
		if (this.showProperties && this.visibleProperties.length > 0) {
			const isBatchPropVisible = this.visibleProperties.some((pid) => parsePropertyId(pid).name === property);
			if (isBatchPropVisible) {
				for (const p of paths) {
					const pending = this.pendingWritten.get(this.pendingKey(p, property));
					const optimisticVal = pending ? pending.value : value;
					const it = this.layoutItems.find((i) => i.mediaFile.path === p);
					// Track pending for virtual remount even if el is null (mountItem reads pendingWritten)
					if (!it?.el) continue;
					const old = it.el.querySelector(".mc-waterfall-props");
					if (old) { if (it.propsHeight > 0) it.itemHeight -= it.propsHeight; old.remove(); it.propsMeasured = false; it.propsHeight = 0; }
					const fakeEntry = {
						getValue: (pid: BasesPropertyId) => {
							const n = parsePropertyId(pid).name;
							if (n === property) return toDisplayValue(property, optimisticVal) as any;
							return this.getBasesValue(it, pid) as any;
						},
					} as unknown as BasesEntry;
					this.renderProperties(it.el, fakeEntry);
					requestAnimationFrame(() => {
						if (!it.el || it.propsMeasured) return;
						const propsEl = it.el!.querySelector(".mc-waterfall-props") as HTMLElement | null;
						const h = propsEl ? propsEl.offsetHeight : 0;
						it.propsMeasured = true; it.propsHeight = h;
						if (h > 0) { const newH = it.itemHeight + h; it.el!.style.height = `${newH}px`; this.reflowColumn(it, newH); }
					});
				}
			}
		}
		this.clearSelection();
	}

	/**
	 * Unmount and re-mount all currently visible items so they pick up
	 * the latest plugin settings (e.g. fullscreen mode changes).
	 */
	private refreshVisibleItems(): void {
		for (const item of this.layoutItems) {
			if (item.el) {
				item.el.remove();
				item.el = null;
			}
		}
		this.syncDOM();
	}

	onunload(): void {
		if (this.rafId !== null) cancelAnimationFrame(this.rafId);
		this.clearHoverTimer();
		this.dismissFullscreen();
		this.resizeObserver.disconnect();
		if (this.settingsChangedRef) {
			this.app.workspace.off("mc:settings-changed" as any, this.settingsChangedRef);
		}
		this.clearDOM();
	}
}

export function getWaterfallViewOptions(): any[] {
	return [
		{
			type: "group",
			displayName: "Layout",
			items: [
				{
					type: "slider",
					key: "columnWidth",
					displayName: "Column width",
					default: 200,
					min: 80,
					max: 600,
					step: 10,
					instant: true,
				},
				{
					type: "slider",
					key: "gap",
					displayName: "Gap",
					default: 8,
					min: 0,
					max: 24,
					step: 2,
					instant: true,
				},
				{
					type: "toggle",
					key: "showFilename",
					displayName: "Show filename",
					default: true,
				},
				{
					type: "toggle",
					key: "showProperties",
					displayName: "Show properties",
					default: false,
				},
			],
		},
		{
			type: "group",
			displayName: "Search",
			items: [
				{
					type: "text",
					key: "searchQuery",
					displayName: "Search",
					default: "",
					placeholder: "Filter by name or pathÔÇª",
					instant: true,
				},
			],
		},
		{
			type: "group",
			displayName: "Media Filters",
			items: [
				{
					type: "dropdown",
					key: "filterShape",
					displayName: "Shape",
					default: "",
					options: {
						"": "Any",
						"square": "Square",
						"horizontal": "Horizontal",
						"vertical": "Vertical",
					},
				},
				{
					type: "text",
					key: "filterColor",
					displayName: "Colour (hex)",
					default: "",
					placeholder: "#ff0000",
				},
				{
					type: "slider",
					key: "colorThreshold",
					displayName: "Colour proximity (%)",
					default: 50,
					min: 1,
					max: 100,
					step: 1,
				},
				{
					type: "text",
					key: "filterMinWidth",
					displayName: "Min width (px)",
					default: "",
					placeholder: "0",
				},
				{
					type: "text",
					key: "filterMaxWidth",
					displayName: "Max width (px)",
					default: "",
					placeholder: "0",
				},
				{
					type: "text",
					key: "filterMinHeight",
					displayName: "Min height (px)",
					default: "",
					placeholder: "0",
				},
				{
					type: "text",
					key: "filterMaxHeight",
					displayName: "Max height (px)",
					default: "",
					placeholder: "0",
				},
			],
		},
	];
}
