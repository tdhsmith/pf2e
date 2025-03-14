import { isBlank, localizer, sluggify } from "@util";
import { CompendiumBrowserSources } from "./index.ts";
import { Progress } from "@system/progress.ts";

class PackLoader {
    loadedPacks: {
        Actor: Record<string, { pack: CompendiumCollection; index: CompendiumIndex } | undefined>;
        Item: Record<string, { pack: CompendiumCollection; index: CompendiumIndex } | undefined>;
    } = { Actor: {}, Item: {} };

    loadedSources: string[] = [];
    sourcesSettings: CompendiumBrowserSources;

    constructor() {
        this.sourcesSettings = game.settings.get("pf2e", "compendiumBrowserSources");
    }

    async *loadPacks(
        documentType: "Actor" | "Item",
        packs: string[],
        indexFields: string[]
    ): AsyncGenerator<{ pack: CompendiumCollection<CompendiumDocument>; index: CompendiumIndex }, void, unknown> {
        this.loadedPacks[documentType] ??= {};
        const localize = localizer("PF2E.ProgressBar");
        const sources = this.#getSources();

        const progress = new Progress({ max: packs.length });
        for (const packId of packs) {
            let data = this.loadedPacks[documentType][packId];
            if (data) {
                const { pack } = data;
                progress.advance({ label: localize("LoadingPack", { pack: pack?.metadata.label ?? "" }) });
            } else {
                const pack = game.packs.get(packId);
                if (!pack) {
                    progress.advance();
                    continue;
                }
                progress.advance({ label: localize("LoadingPack", { pack: pack.metadata.label }) });
                if (pack.documentName === documentType) {
                    const index = await pack.getIndex({ fields: indexFields });
                    const firstResult: Partial<CompendiumIndexData> = index.contents.at(0) ?? {};
                    // Every result should have the "system" property otherwise the indexFields were wrong for that pack
                    if (firstResult.system) {
                        const filteredIndex = this.#createFilteredIndex(index, sources);
                        this.#setModuleArt(packId, filteredIndex);
                        data = { pack, index: filteredIndex };
                        this.loadedPacks[documentType][packId] = data;
                    } else {
                        ui.notifications.warn(
                            game.i18n.format("PF2E.BrowserWarnPackNotLoaded", { pack: pack.collection })
                        );
                        continue;
                    }
                } else {
                    continue;
                }
            }

            yield data;
        }
        progress.close({ label: localize("LoadingComplete") });
    }

    /** Set art provided by a module if any is available */
    #setModuleArt(packName: string, index: CompendiumIndex): void {
        if (!packName.startsWith("pf2e.")) return;
        for (const record of index) {
            const uuid: CompendiumUUID = `Compendium.${packName}.${record._id}`;
            const actorArt = game.pf2e.system.moduleArt.map.get(uuid)?.img;
            record.img = actorArt ?? record.img;
        }
    }

    #getSources(): Set<string> {
        const sources = new Set<string>();
        for (const source of Object.values(this.sourcesSettings.sources)) {
            if (source?.load) {
                sources.add(source.name);
            }
        }
        return sources;
    }

    #createFilteredIndex(index: CompendiumIndex, sources: Set<string>): CompendiumIndex {
        if (sources.size === 0) {
            // Make sure everything works as before as long as the settings are not yet defined
            return index;
        }

        if (game.user.isGM && this.sourcesSettings.ignoreAsGM) {
            return index;
        }

        const filteredIndex: CompendiumIndex = new Collection<CompendiumIndexData>();
        const knownSources = Object.values(this.sourcesSettings.sources).map((value) => value?.name);

        for (const document of index) {
            const source = this.#getSourceFromDocument(document);
            const blank = isBlank(source);

            if (
                (blank && this.sourcesSettings.showEmptySources) ||
                sources.has(source) ||
                (this.sourcesSettings.showUnknownSources && !blank && !knownSources.includes(source))
            ) {
                filteredIndex.set(document._id, document);
            }
        }
        return filteredIndex;
    }

    async updateSources(packs: string[]): Promise<void> {
        await this.#loadSources(packs);

        for (const source of this.loadedSources) {
            const slug = sluggify(source);
            if (this.sourcesSettings.sources[slug] === undefined) {
                this.sourcesSettings.sources[slug] = {
                    load: this.sourcesSettings.showUnknownSources,
                    name: source,
                };
            }
        }

        // Make sure it can be easily displayed sorted
        this.sourcesSettings.sources = Object.fromEntries(
            Object.entries(this.sourcesSettings.sources).sort((a, b) => a[0].localeCompare(b[0], game.i18n.lang))
        );
    }

    async #loadSources(packs: string[]): Promise<void> {
        const localize = localizer("PF2E.ProgressBar");
        const progress = new Progress({ max: packs.length });

        const loadedSources = new Set<string>();
        const indexFields = ["system.details.source.value", "system.source.value"];
        const knownDocumentTypes = ["Actor", "Item"];

        for (const packId of packs) {
            const pack = game.packs.get(packId);
            if (!pack || !knownDocumentTypes.includes(pack.documentName)) {
                progress.advance();
                continue;
            }
            progress.advance({ label: localize("LoadingPack", { pack: pack?.metadata.label ?? "" }) });
            const index = await pack.getIndex({ fields: indexFields });

            for (const element of index) {
                const source = this.#getSourceFromDocument(element);
                if (source && source !== "") {
                    loadedSources.add(source);
                }
            }
        }

        progress.close({ label: localize("LoadingComplete") });
        const loadedSourcesArray = Array.from(loadedSources).sort();
        this.loadedSources = loadedSourcesArray;
    }

    #getSourceFromDocument(document: CompendiumIndexData): string {
        // There are two possible fields where the source can be, check them in order
        if (document.system?.details?.source?.value) {
            return document.system.details.source.value;
        }

        if (document.system?.source?.value) {
            return document.system.source.value;
        }

        return "";
    }

    reset(): void {
        this.loadedPacks = { Actor: {}, Item: {} };
        this.loadedSources = [];
    }

    async hardReset(packs: string[]): Promise<void> {
        this.reset();
        this.sourcesSettings = {
            ignoreAsGM: true,
            showEmptySources: true,
            showUnknownSources: true,
            sources: {},
        };
        await this.updateSources(packs);
    }
}

export { PackLoader };
