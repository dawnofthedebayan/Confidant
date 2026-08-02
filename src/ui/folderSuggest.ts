import { AbstractInputSuggest, App, TFolder } from "obsidian";

/** Vault-folder autocomplete for the source/output folder settings. */
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(app: App, private inputEl: HTMLInputElement, private onPick: (path: string) => void) {
		super(app, inputEl);
	}

	getSuggestions(query: string): TFolder[] {
		const lower = query.toLowerCase();
		const folders: TFolder[] = [];
		for (const file of this.app.vault.getAllLoadedFiles()) {
			if (file instanceof TFolder && file.path.toLowerCase().includes(lower)) {
				folders.push(file);
			}
		}
		return folders.sort((a, b) => a.path.localeCompare(b.path)).slice(0, 50);
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path || "/");
	}

	selectSuggestion(folder: TFolder): void {
		this.inputEl.value = folder.path;
		this.inputEl.trigger("input");
		this.onPick(folder.path);
		this.close();
	}
}
