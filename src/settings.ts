export interface MediaCompanionSettings {
	hideSidecar: boolean;
	extensions: string[];
	excludedFolders: string[];
	sidecarTemplate: string;

	apiEnabled: boolean;
	apiPort: number;
	apiKey: string;

	fullscreenMode: "off" | "hover" | "click";
	fullscreenHoverDelay: number;
}

export const DEFAULT_SETTINGS: MediaCompanionSettings = {
	hideSidecar: true,
	extensions: [
		'png',
		'jpg',
		'jpeg',
		'bmp',
		'avif',
		'webp',
		'gif',
		'mp4',
		'webm',
		'ogv',
		'mov',
	],
	excludedFolders: [],
	sidecarTemplate: "",

	apiEnabled: false,
	apiPort: 27124,
	apiKey: "",

	fullscreenMode: "hover",
	fullscreenHoverDelay: 1000,
}

/**
 * Normalizes a vault path for comparison (forward slashes, no leading/trailing slashes).
 */
export function normalizeVaultPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/**
 * Whether a file path lives inside one of the excluded folders (or a subfolder).
 */
export function isPathExcluded(path: string, excludedFolders: string[]): boolean {
	if (!excludedFolders || excludedFolders.length === 0) return false;

	const normalized = normalizeVaultPath(path);

	for (const folder of excludedFolders) {
		const normalizedFolder = normalizeVaultPath(folder);
		if (!normalizedFolder) continue;
		if (normalized === normalizedFolder || normalized.startsWith(`${normalizedFolder}/`)) return true;
	}

	return false;
}
