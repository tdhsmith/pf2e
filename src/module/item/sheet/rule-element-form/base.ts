import type { ItemPF2e } from "@item/base.ts";
import { isBracketedValue } from "@module/rules/helpers.ts";
import { RuleElements, type RuleElementPF2e, type RuleElementSource } from "@module/rules/index.ts";
import { ResolvableValueField, RuleElementSchema } from "@module/rules/rule-element/data.ts";
import type { LaxSchemaField } from "@system/schema-data-fields.ts";
import { createHTMLElement, fontAwesomeIcon, htmlClosest, htmlQuery, htmlQueryAll, isObject, tagify } from "@util";
import * as R from "remeda";
import type { DataField } from "types/foundry/common/data/fields.d.ts";

interface RuleElementFormOptions<TSource extends RuleElementSource, TObject extends RuleElementPF2e> {
    item: ItemPF2e;
    index: number;
    rule: TSource;
    object: TObject | null;
}

/** Base Rule Element form handler. Form handlers intercept sheet events to support new UI */
class RuleElementForm<
    TSource extends RuleElementSource = RuleElementSource,
    TObject extends RuleElementPF2e = RuleElementPF2e
> {
    template = "systems/pf2e/templates/items/rules/default.hbs";

    declare item: ItemPF2e;
    declare index: number;
    declare rule: TSource;
    declare object: TObject | null;
    declare schema: LaxSchemaField<RuleElementSchema> | null;

    /** Tab configuration data */
    protected tabs: RuleElementFormTabData | null = null;
    /** The currently active tab */
    #activeTab: Maybe<string> = null;

    /** Base proprety path for the contained rule */
    get basePath(): string {
        return `system.rules.${this.index}`;
    }

    constructor(options: RuleElementFormOptions<TSource, TObject>) {
        this.initialize(options);
    }

    initialize(options: RuleElementFormOptions<TSource, TObject>): void {
        this.item = options.item;
        this.index = options.index;
        this.rule = options.rule;
        this.object = options.object;
        this.schema = this.object?.constructor.schema ?? RuleElements.all[String(this.rule.key)]?.schema ?? null;
    }

    /** Returns the initial value of the schema. Arrays are stripped due to how they're handled in forms */
    protected getInitialValue(): object {
        // Only apply to real forms for now
        if (this.constructor.name === "RuleElementForm") return {};

        const initial: Partial<SourceFromSchema<RuleElementSchema>> | undefined = this.schema?.getInitialValue();
        if (!initial) return {};
        for (const property of ["ignored", "priority", "slug"] as const) {
            delete initial[property];
        }

        const removeArrays = (object: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(object)) {
                if (Array.isArray(value)) {
                    delete object[key];
                } else if (isObject<Record<string, unknown>>(value)) {
                    removeArrays(value);
                }
            }
        };
        removeArrays(initial);

        return initial;
    }

    async getData(): Promise<RuleElementFormSheetData<TSource, TObject>> {
        const localization = CONFIG.PF2E.ruleElement;
        const key = String(this.rule.key).replace(/^PF2E\.RuleElement\./, "");
        const label = game.i18n.localize(localization[key as keyof typeof localization] ?? localization.Unrecognized);
        const recognized = label !== game.i18n.localize(localization.Unrecognized);

        const mergedRule = mergeObject(this.getInitialValue(), this.rule);

        return {
            ...R.pick(this, ["item", "index", "rule", "object"]),
            label,
            recognized,
            basePath: this.basePath,
            rule: mergedRule,
            fields: this.schema?.fields,
            form: await this.#getFormHelpers(mergedRule),
        };
    }

    async #getFormHelpers(rule: TSource): Promise<Record<string, unknown>> {
        const valueTemplate = await getTemplate("systems/pf2e/templates/items/rules/partials/resolvable-value.hbs");
        const bracketsTemplate = await getTemplate(
            "systems/pf2e/templates/items/rules/partials/resolvable-brackets.hbs"
        );

        const getResolvableData = (property: string) => {
            const value = getProperty(rule, property);
            const mode = isBracketedValue(value) ? "brackets" : isObject(value) ? "object" : "primitive";
            return { value, mode, property, path: `${this.basePath}.${property}` };
        };

        return {
            resolvableValue: (property: string) =>
                valueTemplate({
                    ...getResolvableData(property),
                    inputId: `${this.item.uuid}-${this.index}-${property}`,
                }),

            resolvableAddBracket: (property: string) => {
                const data = getResolvableData(property);
                if (data.mode !== "brackets") return "";
                return createHTMLElement("a", {
                    children: [fontAwesomeIcon("fa-plus", { fixedWidth: true })],
                    dataset: {
                        action: "add-bracket",
                        property,
                    },
                }).outerHTML;
            },
            resolvableBrackets: (property: string) => {
                return bracketsTemplate(getResolvableData(property));
            },
        };
    }

    async render(): Promise<string> {
        const data = await this.getData();
        return renderTemplate("systems/pf2e/templates/items/rules/outer.hbs", {
            ...data,
            template: await renderTemplate(this.template, data),
        });
    }

    /**
     * Helper to update the item with the new rule data.
     * This function exists because array updates in foundry are currently clunky
     */
    updateItem(updates: Partial<TSource> | Record<string, unknown>): void {
        const rules: Record<string, unknown>[] = this.item.toObject().system.rules;
        rules[this.index] = mergeObject(this.rule, updates, { performDeletions: true });
        this.item.update({ [`system.rules`]: rules });
    }

    activateListeners(html: HTMLElement): void {
        // Tagify selectors lists
        const selectorElement = htmlQuery<HTMLInputElement>(html, ".selector-list");
        tagify(selectorElement);

        for (const button of htmlQueryAll(html, "[data-action=toggle-brackets]")) {
            button.addEventListener("click", () => {
                const property = button.dataset.property ?? "value";
                const value = getProperty(this.rule, property);
                if (isBracketedValue(value)) {
                    this.updateItem({ [property]: "" });
                } else {
                    this.updateItem({ [property]: { brackets: [{ value: "" }] } });
                }
            });
        }

        for (const button of htmlQueryAll(html, "[data-action=add-bracket]")) {
            const property = button.dataset.property ?? "value";
            button.addEventListener("click", () => {
                const value = getProperty(this.rule, property);
                if (isBracketedValue(value)) {
                    value.brackets.push({ value: "" });
                    this.updateItem({ [property]: value });
                }
            });
        }

        for (const button of htmlQueryAll(html, "[data-action=delete-bracket]")) {
            const property = button.dataset.property ?? "value";
            button.addEventListener("click", () => {
                const value = getProperty(this.rule, property);
                const idx = Number(htmlClosest(button, "[data-idx]")?.dataset.idx);
                if (isBracketedValue(value)) {
                    value.brackets.splice(idx, 1);
                    this.updateItem({ [property]: value });
                }
            });
        }

        if (this.tabs) {
            for (const anchor of htmlQueryAll(html, "a[data-rule-tab]")) {
                anchor.addEventListener("click", () => {
                    this.activateTab(html, anchor.dataset.ruleTab);
                });
            }
            this.activateTab(html, this.#activeTab);
        }
    }

    protected activateTab(html: HTMLElement, tabName: Maybe<string>): void {
        if (!this.tabs) return;
        const activeTab = tabName ?? this.tabs.names.at(0);
        if (!activeTab || !this.tabs.names.includes(activeTab)) return;
        this.#activeTab = activeTab;

        for (const element of htmlQueryAll(html, "[data-rule-tab]")) {
            if (element.dataset.ruleTab === activeTab) {
                element.classList.add("active");
                if (element.tagName !== "A") {
                    element.style.display = this.tabs.displayStyle;
                }
            } else {
                element.classList.remove("active");
                if (element.tagName !== "A") {
                    element.style.display = "none";
                }
            }
        }
    }

    updateObject(source: TSource & Record<string, unknown>): void {
        // Predicate is special cased as always json. Later on extend such parsing to more things
        const predicateValue = source.predicate;
        if (typeof predicateValue === "string") {
            if (predicateValue.trim() === "") {
                delete source.predicate;
            } else {
                try {
                    source.predicate = JSON.parse(predicateValue);
                } catch (error) {
                    if (error instanceof Error) {
                        ui.notifications.error(
                            game.i18n.format("PF2E.ErrorMessage.RuleElementSyntax", { message: error.message })
                        );
                        throw error; // prevent update, to give the user a chance to correct, and prevent bad data
                    }
                }
            }
        }

        if (this.schema) {
            cleanDataUsingSchema(this.schema.fields, source);
        }

        // Update our reference so that equality matching works on the next data prep cycle
        // This allows form reuse to occur
        this.rule = source;
    }
}

/** Recursively clean and remove all fields that have a default value */
function cleanDataUsingSchema(schema: Record<string, DataField>, data: Record<string, unknown>) {
    const { fields } = foundry.data;
    for (const [key, field] of Object.entries(schema)) {
        if (!(key in data)) continue;
        const value = data[key];

        if (field instanceof ResolvableValueField) {
            data[key] = getCleanedResolvable(value);
            continue;
        }

        if ("fields" in field && R.isObject(value)) {
            cleanDataUsingSchema(field.fields as Record<string, DataField>, value);
            continue;
        }

        // Allow certain field types to clean the data. Unfortunately we cannot do it to all.
        // Arrays need to allow string inputs (some selectors) and StrictArrays are explodey
        // The most common benefit from clean() is handling things like the "blank" property
        if (field instanceof fields.StringField) {
            data[key] = field.clean(value, {});
        }

        // Remove if its the initial value, or if its a blank string for an array field (usually a selector)
        const isBlank = typeof value === "string" && value.trim() === "";
        const isInitial = "initial" in field && R.equals(field.initial, value);
        if (isInitial || (field instanceof fields.ArrayField && isBlank)) {
            delete data[key];
        }
    }
}

/** Utility function to convert a value to a number if its a valid number */
function coerceNumber<T extends string | unknown>(value: T): T | number {
    if (value !== "" && !isNaN(Number(value))) {
        return Number(value);
    }

    return value;
}

function getCleanedResolvable(value: unknown) {
    // Convert brackets to array, and coerce the value types
    if (isObject<{ brackets: object; field: string }>(value) && "brackets" in value) {
        const brackets = (value.brackets = Array.from(Object.values(value.brackets ?? {})));

        if (value.field === "") {
            delete value.field;
        }

        for (const bracket of brackets) {
            if (bracket.start === null) delete bracket.start;
            if (bracket.end === null) delete bracket.end;
            bracket.value = isObject(bracket.value) ? "" : coerceNumber(bracket.value);
        }

        return value;
    } else if (!isObject(value)) {
        return coerceNumber(value ?? "");
    }

    return value;
}

interface RuleElementFormSheetData<TSource extends RuleElementSource, TObject extends RuleElementPF2e>
    extends RuleElementFormOptions<TSource, TObject> {
    label: string;
    recognized: boolean;
    basePath: string;
    fields: RuleElementSchema | undefined;
    /** A collection of additional handlebars functions */
    form: Record<string, unknown>;
}

interface RuleElementFormTabData {
    /** Valid tab names for this form */
    names: string[];
    /** The display style applied to active tabs */
    displayStyle: "block" | "flex" | "grid";
}

export { RuleElementForm };
export type { RuleElementFormSheetData, RuleElementFormTabData };
