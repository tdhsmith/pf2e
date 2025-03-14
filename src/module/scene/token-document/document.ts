import { ActorPF2e } from "@actor";
import { PrototypeTokenPF2e } from "@actor/data/base.ts";
import type { TokenPF2e } from "@module/canvas/index.ts";
import { ChatMessagePF2e } from "@module/chat-message/document.ts";
import type { CombatantPF2e, EncounterPF2e } from "@module/encounter/index.ts";
import { objectHasKey, sluggify } from "@util";
import * as R from "remeda";
import { LightLevels } from "../data.ts";
import type { ScenePF2e } from "../document.ts";
import type { ActorDeltaPF2e } from "./actor-delta.ts";
import { TokenAura } from "./aura/index.ts";
import { TokenFlagsPF2e } from "./data.ts";
import type { TokenConfigPF2e } from "./sheet.ts";

class TokenDocumentPF2e<TParent extends ScenePF2e | null = ScenePF2e | null> extends TokenDocument<TParent> {
    /** Has this token gone through at least one cycle of data preparation? */
    private constructed = true;

    declare auras: Map<string, TokenAura>;

    /** Returns if the token is in combat, though some actors have different conditions */
    override get inCombat(): boolean {
        if (this.actor?.isOfType("party")) {
            return this.actor.members.every((a) => game.combat?.getCombatantByActor(a.id));
        }

        return super.inCombat;
    }

    /** Check actor for effects found in `CONFIG.specialStatusEffects` */
    override hasStatusEffect(statusId: string): boolean {
        if (statusId === "dead") return this.overlayEffect === CONFIG.controlIcons.defeated;

        const { actor } = this;
        if (!actor || !game.settings.get("pf2e", "automation.rulesBasedVision")) {
            return false;
        }

        const hasCondition = objectHasKey(CONFIG.PF2E.conditionTypes, statusId) && actor.hasCondition(statusId);
        const hasEffect = () => actor.itemTypes.effect.some((e) => (e.slug ?? sluggify(e.name)) === statusId);

        return hasCondition || hasEffect();
    }

    /** Filter trackable attributes for relevance and avoidance of circular references */
    static override getTrackedAttributes(
        data: Record<string, unknown> = {},
        _path: string[] = []
    ): TrackedAttributesDescription {
        // This method is being called with no associated actor: fill from the models
        if (_path.length === 0 && Object.keys(data).length === 0) {
            for (const [type, model] of Object.entries(game.system.model.Actor)) {
                if (!["character", "npc"].includes(type)) continue;
                foundry.utils.mergeObject(data, model);
            }
        }

        if (_path.length > 0) {
            return super.getTrackedAttributes(data, _path);
        }

        const patterns = {
            positive: /^(?:attributes|resources)\./,
            negative: /\b(?:rank|_?modifiers|item|classdc|dexcap|familiar|\w+hp\b)|bonus/i,
        };

        const prunedData = expandObject<Record<string, unknown>>(
            Object.fromEntries(
                Object.entries(flattenObject(data)).filter(
                    ([k, v]) =>
                        patterns.positive.test(k) &&
                        !patterns.negative.test(k) &&
                        !["boolean", "string"].includes(typeof v)
                )
            )
        );

        return super.getTrackedAttributes(prunedData, _path);
    }

    /** This should be in Foundry core, but ... */
    get scene(): this["parent"] {
        return this.parent;
    }

    /** Is this token emitting light with a negative value */
    get emitsDarkness(): boolean {
        return this.light.bright < 0;
    }

    get rulesBasedVision(): boolean {
        return !!(this.sight.enabled && this.actor?.isOfType("character", "familiar") && this.scene?.rulesBasedVision);
    }

    /** Is rules-based vision enabled, and does this token's actor have low-light vision (inclusive of darkvision)? */
    get hasLowLightVision(): boolean {
        return !!(this.rulesBasedVision && this.actor?.isOfType("creature") && this.actor.hasLowLightVision);
    }

    /** Is rules-based vision enabled, and does this token's actor have darkvision vision? */
    get hasDarkvision(): boolean {
        return !!(this.rulesBasedVision && this.actor?.isOfType("creature") && this.actor.hasDarkvision);
    }

    /** Is this token's dimensions linked to its actor's size category? */
    get linkToActorSize(): boolean {
        return this.flags.pf2e.linkToActorSize;
    }

    /** Is this token's scale locked at 1 or (for small creatures) 0.8? */
    get autoscale(): boolean {
        return this.flags.pf2e.autoscale;
    }

    get playersCanSeeName(): boolean {
        const anyoneCanSee: TokenDisplayMode[] = [CONST.TOKEN_DISPLAY_MODES.ALWAYS, CONST.TOKEN_DISPLAY_MODES.HOVER];
        const nameDisplayMode = this.displayName;
        return anyoneCanSee.includes(nameDisplayMode) || this.actor?.alliance === "party";
    }

    /** The pixel-coordinate definition of this token's space */
    get bounds(): PIXI.Rectangle {
        const gridSize = this.scene?.grid.size ?? 100;
        // Use source values since coordinates are changed in real time over the course of movement animation
        return new PIXI.Rectangle(this._source.x, this._source.y, this.width * gridSize, this.height * gridSize);
    }

    /** Bounds used for mechanics, such as flanking and drawing auras */
    get mechanicalBounds(): PIXI.Rectangle {
        const bounds = this.bounds;
        if (this.width < 1) {
            const position = canvas.grid.getTopLeft(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
            return new PIXI.Rectangle(
                position[0],
                position[1],
                Math.max(canvas.grid.size, bounds.width),
                Math.max(canvas.grid.size, bounds.height)
            );
        }

        return bounds;
    }

    /** The pixel-coordinate pair constituting this token's center */
    get center(): Point {
        const { bounds } = this;
        return {
            x: bounds.x + bounds.width / 2,
            y: bounds.y + bounds.height / 2,
        };
    }

    protected override _initialize(options?: Record<string, unknown>): void {
        this.constructed ??= false;
        this.auras = new Map();

        this._source.flags.pf2e ??= {};
        this._source.flags.pf2e.linkToActorSize ??= true;
        this._source.flags.pf2e.autoscale = this._source.flags.pf2e.linkToActorSize
            ? this._source.flags.pf2e.autoscale ?? game.settings.get("pf2e", "tokens.autoscale")
            : false;

        super._initialize(options);
    }

    /** If embedded, don't prepare data if the parent's data model hasn't initialized all its properties */
    override prepareData(): void {
        if (this.parent && !this.parent.flags?.pf2e) return;

        super.prepareData();
    }

    /** If rules-based vision is enabled, disable manually configured vision radii */
    override prepareBaseData(): void {
        super.prepareBaseData();

        this.auras.clear();

        if (!this.actor || !this.isEmbedded) return;

        TokenDocumentPF2e.assignDefaultImage(this);

        for (const [key, data] of this.actor.auras.entries()) {
            this.auras.set(key, new TokenAura({ token: this, ...deepClone(data) }));
        }

        if (!this.constructed) return;

        // Dimensions and scale
        const linkDefault = !["hazard", "loot", "party"].includes(this.actor.type ?? "");
        const linkToActorSize = this.flags.pf2e?.linkToActorSize ?? linkDefault;

        const autoscaleDefault = game.settings.get("pf2e", "tokens.autoscale");
        // Autoscaling is a secondary feature of linking to actor size
        const autoscale = linkToActorSize ? this.flags.pf2e.autoscale ?? autoscaleDefault : false;
        this.flags.pf2e = mergeObject(this.flags.pf2e ?? {}, { linkToActorSize, autoscale });

        // Alliance coloration, appropriating core token dispositions
        const { alliance } = this.actor.system.details;
        this.disposition = alliance
            ? {
                  party: CONST.TOKEN_DISPOSITIONS.FRIENDLY,
                  opposition: CONST.TOKEN_DISPOSITIONS.HOSTILE,
              }[alliance]
            : CONST.TOKEN_DISPOSITIONS.NEUTRAL;
    }

    /** Reset sight defaults if using rules-based vision */
    protected override _prepareDetectionModes(): void {
        if (!(this.constructed && this.actor && this.rulesBasedVision)) {
            return super._prepareDetectionModes();
        }

        this.detectionModes = [{ id: "basicSight", enabled: true, range: 0 }];
        if (["character", "familiar"].includes(this.actor.type)) {
            this.sight.attenuation = 0.1;
            this.sight.brightness = 0;
            this.sight.contrast = 0;
            this.sight.range = 0;
            this.sight.saturation = 0;
            this.sight.visionMode = "basic";
        }
    }

    override prepareDerivedData(): void {
        super.prepareDerivedData();
        if (!(this.constructed && this.actor && this.scene)) return;

        // Merge token overrides from REs into this document
        const { tokenOverrides } = this.actor.synthetics;
        this.name = tokenOverrides.name ?? this.name;

        if (tokenOverrides.texture) {
            this.texture.src = tokenOverrides.texture.src;
            if ("scaleX" in tokenOverrides.texture) {
                this.texture.scaleX = tokenOverrides.texture.scaleX;
                this.texture.scaleY = tokenOverrides.texture.scaleY;
                this.flags.pf2e.autoscale = false;
            }
            this.texture.tint = tokenOverrides.texture.tint ?? this.texture.tint;
        }

        this.alpha = tokenOverrides.alpha ?? this.alpha;

        if (tokenOverrides.light) {
            this.light = new foundry.data.LightData(tokenOverrides.light, {
                parent: this as unknown as foundry.abstract.DataModel,
            });
        }

        // Token dimensions from actor size
        TokenDocumentPF2e.prepareSize(this);

        // Set vision and detection modes
        this.#prepareDerivedPerception();
    }

    /** Set vision and detection modes based on actor data */
    #prepareDerivedPerception(): void {
        if (!(this.rulesBasedVision && this.actor && this.scene && this.sight.enabled)) {
            return;
        }

        const visionMode = this.hasDarkvision ? "darkvision" : "basic";
        this.sight.visionMode = visionMode;
        const { defaults } = CONFIG.Canvas.visionModes[visionMode].vision;
        this.sight.brightness = defaults.brightness ?? 0;
        this.sight.saturation = defaults.saturation ?? 0;

        if (visionMode === "darkvision" || this.scene.lightLevel > LightLevels.DARKNESS) {
            const basicDetection = this.detectionModes.at(0);
            if (!basicDetection) return;
            this.sight.range = basicDetection.range = defaults.range ?? 0;

            if (this.actor.isOfType("character") && this.actor.flags.pf2e.colorDarkvision) {
                this.sight.saturation = 1;
            } else if (!game.user.settings.monochromeDarkvision) {
                this.sight.saturation = 0;
            }
        }

        const canSeeInvisibility =
            this.actor.isOfType("character", "familiar") &&
            this.actor.system.traits.senses.some((s) => s.type === "seeInvisibility");
        if (canSeeInvisibility) {
            this.detectionModes.push({ id: "seeInvisibility", enabled: true, range: 1000 });
        }

        const tremorsense = this.actor.isOfType("character")
            ? this.actor.system.traits.senses.find((s) => s.type === "tremorsense" && s.acuity !== "vague")
            : null;
        if (tremorsense) {
            this.detectionModes.push({ id: "feelTremor", enabled: true, range: tremorsense.range });
        }

        if (!this.actor.hasCondition("deafened")) {
            const range = this.scene.flags.pf2e.hearingRange ?? canvas.dimensions?.maxR ?? Infinity;
            this.detectionModes.push({ id: "hearing", enabled: true, range });
        }
    }

    /** Synchronize the token image with the actor image if the token does not currently have an image */
    static assignDefaultImage(token: TokenDocumentPF2e | PrototypeTokenPF2e<ActorPF2e>): void {
        const { actor } = token;
        if (!actor) return;

        const defaultIcons = [ActorPF2e.DEFAULT_ICON, `systems/pf2e/icons/default-icons/${actor.type}.svg`];

        // Always override token images if in Nath mode
        if (game.settings.get("pf2e", "nathMode") && defaultIcons.includes(token.texture.src)) {
            token.texture.src = ((): ImageFilePath | VideoFilePath => {
                switch (actor.alliance) {
                    case "party":
                        return "systems/pf2e/icons/default-icons/alternatives/nath/ally.webp";
                    case "opposition":
                        return "systems/pf2e/icons/default-icons/alternatives/nath/enemy.webp";
                    default:
                        return token.texture.src;
                }
            })();
        } else if (defaultIcons.some((path) => token.texture.src?.endsWith(path))) {
            token.texture.src = actor._source.img;
        }
    }

    /** Set a TokenData instance's dimensions from actor data. Static so actors can use for their prototypes */
    static prepareSize(token: TokenDocumentPF2e | PrototypeTokenPF2e<ActorPF2e>): void {
        const { actor } = token;
        if (!(actor && token.flags.pf2e.linkToActorSize)) return;

        // If not overridden by an actor override, set according to creature size (skipping gargantuan)
        const size = {
            tiny: 0.5,
            sm: 1,
            med: 1,
            lg: 2,
            huge: 3,
            grg: Math.max(token.width, 4),
        }[actor.size];
        if (actor.isOfType("vehicle")) {
            // Vehicles can have unequal dimensions
            const { width, height } = actor.getTokenDimensions();
            token.width = width;
            token.height = height;
        } else {
            token.width = size;
            token.height = size;

            if (game.settings.get("pf2e", "tokens.autoscale") && token.flags.pf2e.autoscale !== false) {
                const absoluteScale = actor.size === "sm" ? 0.8 : 1;
                const mirrorX = token.texture.scaleX < 0 ? -1 : 1;
                token.texture.scaleX = mirrorX * absoluteScale;
                const mirrorY = token.texture.scaleY < 0 ? -1 : 1;
                token.texture.scaleY = mirrorY * absoluteScale;
            }
        }
    }

    /** Set a token's initiative on the current encounter, creating a combatant if necessary */
    async setInitiative({
        initiative,
        sendMessage = true,
    }: {
        initiative: number;
        sendMessage?: boolean;
    }): Promise<void> {
        if (!game.combat) {
            ui.notifications.error("PF2E.Encounter.NoActiveEncounter");
            return;
        }

        const currentId = game.combat.combatant?.id;
        if (this.combatant && game.combat.combatants.has(this.combatant.id)) {
            await game.combat.setInitiative(this.combatant.id, initiative);
        } else {
            await game.combat.createEmbeddedDocuments("Combatant", [
                {
                    tokenId: this.id,
                    initiative,
                },
            ]);
        }
        // Ensure the current turn is preserved
        await this.update({ turn: game.combat.turns.findIndex((c) => c.id === currentId) });

        if (sendMessage) {
            await ChatMessagePF2e.createDocuments([
                {
                    speaker: { scene: this.scene?.id, token: this.id },
                    whisper: this.actor?.hasPlayerOwner
                        ? []
                        : game.users.contents.flatMap((user) => (user.isGM ? user.id : [])),
                    content: game.i18n.format("PF2E.InitiativeIsNow", { name: this.name, value: initiative }),
                },
            ]);
        }
    }

    /* -------------------------------------------- */
    /*  Event Handlers                              */
    /* -------------------------------------------- */

    /** Toggle token hiding if this token's actor is a loot actor */
    protected override _onCreate(
        data: this["_source"],
        options: DocumentModificationContext<TParent>,
        userId: string
    ): void {
        super._onCreate(data, options, userId);
        if (game.user.id === userId && this.actor?.isOfType("loot")) {
            this.actor.toggleTokenHiding();
        }
    }

    protected override _onUpdate(
        changed: DeepPartial<this["_source"]>,
        options: DocumentUpdateContext<TParent>,
        userId: string
    ): void {
        // Possibly re-render encounter tracker if token's `displayName` property has changed
        const tokenSetsNameVisibility = game.settings.get("pf2e", "metagame_tokenSetsNameVisibility");
        if ("displayName" in changed && tokenSetsNameVisibility && this.combatant) {
            ui.combat.render();
        }

        // Workaround for actor-data preparation issue: release token if this is made unlinked while controlled
        if (changed.actorLink === false && this.rendered && this.object?.controlled) {
            this.object.release();
        }

        return super._onUpdate(changed, options, userId);
    }

    protected override _onRelatedUpdate(
        update: Record<string, unknown> = {},
        options: DocumentModificationContext<null> = {}
    ): void {
        super._onRelatedUpdate(update, options);

        // Reinitialize vision if the actor's senses were updated directly
        const initializeVision =
            !!this.scene?.isView &&
            this.sight.enabled &&
            Object.keys(flattenObject(update)).some((k) => k.startsWith("system.traits.senses"));
        if (initializeVision) canvas.perception.update({ initializeVision }, true);

        const preUpdate = this.toObject(false);
        const preUpdateAuras = Array.from(this.auras.values()).map((a) => R.omit(a, ["appearance", "token"]));
        this.reset();
        const postUpdate = this.toObject(false);
        const postUpdateAuras = Array.from(this.auras.values()).map((a) => R.omit(a, ["appearance", "token"]));
        const tokenChanges = diffObject<DeepPartial<this["_source"]>>(preUpdate, postUpdate);

        if (this.scene?.isView && Object.keys(tokenChanges).length > 0) {
            this.object?._onUpdate(tokenChanges, {}, game.user.id);
        }

        // Assess the full diff using `diffObject`: additions, removals, and changes
        const aurasChanged = () => !!this.scene?.isInFocus && !R.equals(preUpdateAuras, postUpdateAuras);

        if ("disposition" in tokenChanges || "width" in tokenChanges || "height" in tokenChanges || aurasChanged()) {
            this.scene?.checkAuras?.();
        }
    }

    protected override _onDelete(options: DocumentModificationContext<TParent>, userId: string): void {
        super._onDelete(options, userId);
        if (!this.actor) return;

        if (this.isLinked) {
            // Check area effects, removing any from this token's actor if the actor has no other tokens in the scene
            if (!this.scene?.tokens.some((t) => t.actor === this.actor)) this.actor.checkAreaEffects();
        } else {
            // Actor#_onDelete won't be called, so unregister effects in the effects tracker
            for (const effect of this.actor.itemTypes.effect) {
                game.pf2e.effectTracker.unregister(effect);
            }
        }
    }
}

interface TokenDocumentPF2e<TParent extends ScenePF2e | null = ScenePF2e | null> extends TokenDocument<TParent> {
    flags: TokenFlagsPF2e;

    get actor(): ActorPF2e<this | null> | null;
    get combatant(): CombatantPF2e<EncounterPF2e, this> | null;
    get object(): TokenPF2e<this> | null;
    get sheet(): TokenConfigPF2e<this>;
    delta: ActorDeltaPF2e<this> | null;
}

export { TokenDocumentPF2e };
