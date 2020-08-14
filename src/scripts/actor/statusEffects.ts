import PF2EItem from "src/module/item/item";
import { PF2eConditionManager } from "../../module/conditions";
import { ConditionData, ConditionDetailsData } from '../../module/item/dataDefinitions'

declare var PF2e: any;

/**
 * Class PF2eStatus which defines the data structure of a status effects
 * Gets populated into Actor.data.data.statusEffects[]
 */
export class PF2eStatus {
    status: string;
    active: boolean;
    type: string;
    value: number;
    source: string;

    constructor(statusName, source, value=1, active=true) {
        this.status = statusName;
        this.active = active;
        this.source = source;
        this.type = (getProperty(PF2e.DB.condition, this.status) !== undefined)?'condition':((getProperty(PF2e.DB.status, this.status) !== undefined)?'status':undefined)
        if (this.type !== undefined && getProperty(PF2e.DB[this.type][this.status], 'hasValue') !== undefined) {
            this.value = value;
        }
    }
    get db() {
        if (this.type === undefined)
            return undefined;
        else
            return getProperty(PF2e.DB[this.type], this.status);
    }
}

/**
 * Class PF2eStatusEffects, which is the module to handle the status effects
 */
export class PF2eStatusEffects {

    statusEffectChanged: any;
    static statusEffectChanged: boolean;

    static init() {
        if(CONFIG.PF2E.PF2eStatusEffects.overruledByModule) return;
        
        console.log('PF2e System | Initializing Status Effects Module');
        this.hookIntoFoundry();
        try {
            if ( game.modules.get("combat-utility-belt") !== undefined
                    && game.modules.get("combat-utility-belt").active
                    && game.settings.get('combat-utility-belt', 'enableEnhancedConditions')
                )
                ui.notifications.info(`<strong>PF2e System & Combat Utility Belt</strong><div>You have the CUB module enabled. This may
                cause unexpected side effects with the PF2e system at the moment, but this is expected to improve in future releases. If
                you are experiencing problems with status effects, we recommend you disable CUB's Enhanced Conditions on the Module
                settings.</div>`, {permanent: true});
        } catch {
            ui.notifications.error("The Combat Utility Belt installation check failed. This may cause unexptected side effects with the PF2e system conditions.", {permanent: true});
        }

        const statusEffectType = game.settings.get('pf2e', 'statusEffectType');
        CONFIG.PF2eStatusEffects.lastIconType = statusEffectType;
        CONFIG.PF2eStatusEffects.effectsIconFolder = PF2eStatusEffects.SETTINGOPTIONS.iconTypes[statusEffectType].effectsIconFolder;
        CONFIG.PF2eStatusEffects.effectsIconFileType = PF2eStatusEffects.SETTINGOPTIONS.iconTypes[statusEffectType].effectsIconFileType;
        CONFIG.PF2eStatusEffects.foundryStatusEffects = CONFIG.statusEffects;
        CONFIG.PF2eStatusEffects.keepFoundryStatusEffects = game.settings.get('pf2e', 'statusEffectKeepFoundry');
        /** Update FoundryVTT's CONFIG.statusEffects **/
        this._updateStatusIcons();
    }

    static get SETTINGOPTIONS() {
        //switching to other icons need to migrate all tokens
        return {
            iconTypes: {
                default: {
                    effectsIconFolder: 'systems/pf2e/icons/conditions/',
                    effectsIconFileType: 'png'
                },
                blackWhite: {
                    effectsIconFolder: 'systems/pf2e/icons/conditions-2/',
                    effectsIconFileType: 'png'
                },
                legacy: {
                    effectsIconFolder: 'systems/pf2e/icons/conditions-3/',
                    effectsIconFileType: 'png'
                }
            }
        };
    }

    /**
     * Hook PF2e's status effects into FoundryVTT
     */
    static hookIntoFoundry() {
        /** Register PF2e System setting into FoundryVTT **/
        const statusEffectTypeChoices = {}
        for (let type in PF2eStatusEffects.SETTINGOPTIONS.iconTypes) {
          statusEffectTypeChoices[type] = PF2e.DB.SETTINGS.statusEffectType[type];
        }

        

        game.settings.register('pf2e', 'statusEffectType', {
          name: PF2e.DB.SETTINGS.statusEffectType.name,
          hint: PF2e.DB.SETTINGS.statusEffectType.hint,
          scope: 'world',
          config: true,
          default: 'blackWhite',
          type: String,
          choices: statusEffectTypeChoices,
          onChange: s => {
            PF2eStatusEffects._migrateStatusEffectUrls(s);
          }
        });
        game.settings.register('pf2e', 'statusEffectKeepFoundry', {
          name: PF2e.DB.SETTINGS.statusEffectKeepFoundry.name,
          hint: PF2e.DB.SETTINGS.statusEffectKeepFoundry.hint,
          scope: 'world',
          config: true,
          default: false,
          type: Boolean,
          onChange: () => {
            window.location.reload(false);
          }
        });

        if (game.user.isGM) {
            game.settings.register('pf2e', 'statusEffectShowCombatMessage', {
              name: PF2e.DB.SETTINGS.statusEffectShowCombatMessage.name,
              hint: PF2e.DB.SETTINGS.statusEffectShowCombatMessage.hint,
              scope: 'client',
              config: true,
              default: true,
              type: Boolean,
              onChange: () => {
                  window.location.reload(false);
              }
            });
        }
        /** Create hooks onto FoundryVTT **/
        Hooks.on("renderTokenHUD", (app, html, data) => {
            console.log('PF2e System | Rendering PF2e customized status effects');
            PF2eStatusEffects._hookOnRenderTokenHUD(app, html, data);
        });
        Hooks.on("onTokenHUDClear", (tokenHUD, token) => {
            // Foundry 0.5.7 bug? token parameter is null
            // Workaround: set tokenHUD.token in _hookOnRenderTokenHUD
            token = tokenHUD.token;

            if (tokenHUD._state === tokenHUD?.constructor?.RENDER_STATES?.NONE) {
                // Closing the token HUD
                if (token?.statusEffectChanged === true) {
                    console.log('PF2e System | StatusEffects were updated - Message to chat');
                    token.statusEffectChanged = false;
                    PF2eStatusEffects._createChatMessage(token);
                }
            }
        });

        Hooks.on("updateToken", (scene, tokenData) => {
            // For unlinked token updates.
            const token = canvas.tokens.get(tokenData._id);
            
            //const token = scene.data.tokens.find(t => t._id === tokenData._id);

            PF2eStatusEffects._updateToken(token);
            PF2eStatusEffects._updateHUD(canvas.tokens.hud.element, token);
        });

        Hooks.on("createOwnedItem", async (actor, item) => {
            //let item = (newItem instanceof PF2EItem) ? newItem.data : newItem;
            if (item.uuid) {
                // Got a PF2EItem

                item = item.data;
            }

            if (item.type === "condition" && (item.data.alsoApplies.linked.length > 0 || item.data.alsoApplies.unlinked.length)) {
                game.packs.keys();

                const pack = game.packs.get("pf2e.conditionitems");
                await pack.getIndex();

                for (const i of item.data.alsoApplies.linked) {
                    let entry = pack.index.find(e => e.name === i.condition);

                    let entity = await pack.getEntity(entry._id);

                    entity.data.data.sources.hud = item.data.sources.hud;
                    entity.data.data.sources.values.push({"type":"condition","id":item._id});

                    if (i.value) {
                        entity.data.data.value.value = i.value;
                    }

                    await actor.createEmbeddedEntity('OwnedItem', entity);
                }

                for (const i of item.data.alsoApplies.unlinked) {
                    let entry = pack.index.find(e => e.name === i.condition);

                    let entity = await pack.getEntity(entry._id);

                    entity.data.data.sources.hud = item.data.sources.hud;

                    if (i.value) {
                        entity.data.data.value.value = i.value;
                    }

                    await actor.createEmbeddedEntity('OwnedItem', entity);
                }
            }

            let t = canvas.scene.data.tokens.filter(t => t.actorId === actor._id).pop();
            let token = canvas.tokens.get(t._id);

            PF2eStatusEffects._updateToken(token);
        });

        Hooks.on("preDeleteOwnedItem", async (actor, item) => {
            //let item = (newItem instanceof PF2EItem) ? newItem.data : newItem;
            if (item.uuid) {
                // Got a PF2EItem

                item = item.data;
            }

            const remove = new Array();

            if (item.type === "condition") {
                const x = actor.items.filter(i => i.type === 'condition' && i.data.data.sources.values.length > 0);
                for (const y of x) {
                    if (y.data.data.sources.values.some(a => a.id === item._id)) {
                        remove.push(y._id);
                    }
                }
            }

            await actor.deleteEmbeddedEntity("OwnedItem", remove);
        });

        if ( game.user.isGM && game.settings.get('pf2e', 'statusEffectShowCombatMessage')) {
            let lastTokenId = "";
            Hooks.on("updateCombat", (combat) => {
                const combatant = combat?.combatant;
                const tokenId = combatant?.tokenId;
                if (tokenId !== lastTokenId && combat?.started && combatant?.hasRolled && !combatant?.defeated) {
                    const token = canvas.tokens.get(tokenId);
                    lastTokenId = tokenId;
                    this._createChatMessage(token, combatant.hidden);
                }
                if (!combat?.started && lastTokenId !== "") lastTokenId = "";
            });
        }

        Hooks.on("createToken", (scene, token, options, someId) => {
            console.log('PF2e System | Updating the new token with the actors status effects');
            PF2eStatusEffects._hookOnCreateToken(scene, token);

        });
        Hooks.on("canvasReady", (canvas) => {
            console.log('PF2e System | Updating the scenes token with the actors status effects');
            PF2eStatusEffects._hookOnCanvasReady(canvas);
        });
    }

    static setPF2eStatusEffectControls(html, token) {
        // Status Effects Controls
        let effects = html.find(".status-effects");
        effects.on("click", ".pf2e-effect-control", this._setStatusValue.bind(token))
               .on("contextmenu", ".pf2e-effect-control", this._setStatusValue.bind(token))
               .on("mouseover mouseout", ".pf2e-effect-control", this._showStatusDescr);

        effects.off("click", ".effect-control")
               .on("click", ".effect-control", this._toggleStatus.bind(token));
        effects.off("contextmenu", ".effect-control")
               .on("contextmenu", ".effect-control", this._toggleStatus.bind(token))
               .on("mouseover mouseout", ".effect-control", this._showStatusDescr);
       
    }

    


    /**
     * Updates the core CONFIG.statusEffects with the new icons
     */
    static _updateStatusIcons() {
        var sortableConditions = [];
        let statusEffects = [];
        let socialEffects = [];
        let imgUrl = '';
        for (const condition in PF2e.DB.condition) {
            sortableConditions.push(condition);
        }
        sortableConditions.sort();
        for (const condition of sortableConditions) {
            if (condition.charAt(0) !== '_' && PF2e.DB.condition._groups.death.find(element => element == condition) === undefined) {
                imgUrl = CONFIG.PF2eStatusEffects.effectsIconFolder + condition +'.'+ CONFIG.PF2eStatusEffects.effectsIconFileType;
                if (PF2e.DB.condition._groups.attitudes.find(element => element == condition) !== undefined) {
                    socialEffects.push( imgUrl );
                } else {
                    statusEffects.push( imgUrl );
                }
            }
        }
        socialEffects.sort(function(a, b){
            a = PF2eStatusEffects._getStatusFromImg(a);
            b = PF2eStatusEffects._getStatusFromImg(b);
            return PF2e.DB.condition._groups.attitudes.indexOf(a) - PF2e.DB.condition._groups.attitudes.indexOf(b);
          });
        statusEffects = statusEffects.concat(socialEffects);
        if (CONFIG.PF2eStatusEffects.keepFoundryStatusEffects) {
            CONFIG.statusEffects = statusEffects.concat(CONFIG.PF2eStatusEffects.foundryStatusEffects);
        } else {
            CONFIG.statusEffects = statusEffects;
        }

    }

    static async _hookOnRenderTokenHUD(app, html, tokenData) {
        const token = canvas.tokens.get(tokenData._id);
        const statusIcons = html.find("img.effect-control");

        const affectingConditions = token.actor.data.items.filter(i => i.type === 'condition' && i.data.sources.hud)

        html.find("div.status-effects").append('<div class="status-effect-summary"></div>');
        this.setPF2eStatusEffectControls(html, token);

        // Foundry 0.5.7 bug? Setting tokenHUD.token temporarily until onTokenHUDClear passes token again in its 2nd parameter
        app.token = token;

        for (let i of statusIcons) {
            i = $(i);
            const src = i.attr('src');

            if(src.includes(CONFIG.PF2eStatusEffects.effectsIconFolder)) {
                const statusName = this._getStatusFromImg(src);
                const condition = PF2eConditionManager.getConditionByStatusName(statusName);
                
                i.attr("data-effect", statusName);
                i.attr("data-condition", condition.name);

                let effect = undefined;

                effect = affectingConditions.find(e => e.data.hud.statusName === statusName);

                if(condition.data.data.value.isValued) {
                    i.removeClass('effect-control').addClass('pf2e-effect-control');
                    //retrieve actor and the current effect value
                    
                    i.wrap("<div class='pf2e-effect-img-container'></div>");
                    let v = $("<div class='pf2e-effect-value' style='display:none'>0</div>");
                    i.parent().append(v);
                    
                    if (effect !== undefined) {
                        i.attr("data-value", effect.data.value.value);
                        
                        if (effect.data.value.value > 0) {
                            $(v)
                            .removeAttr('style')
                            .text(effect.data.value.value);
                        }
                    }
                }

                if (i.hasClass('active') && effect === undefined) {
                    i.removeClass('active');
                } else if (!i.hasClass('active') && effect !== undefined) {
                    i.addClass('active');
                }
            }
        }
    }

    static async _updateHUD(html, token) {
        const statusIcons = html.find("img.effect-control, img.pf2e-effect-control");
        const appliedConditions = token.actor.data.items.filter(i => i.type === 'condition' && i.data.sources.hud)

        for (let i of statusIcons) {
            i = $(i);
            const status = i.attr('data-effect');
            const conditionName = i.attr('data-condition');

            if(conditionName) {
                // Icon is a condition

                let condition:ConditionData = appliedConditions.find(e => e.name === conditionName);
                const conditionBase:ConditionData = PF2eConditionManager.getConditionByStatusName(status)?.data;

                if(conditionBase?.data.value.isValued) {
                    // Valued condition

                    let v = $(i).siblings('div.pf2e-effect-value').first();

                    if ($(i).hasClass('active')) {
                        // icon is active.
                        if (condition === undefined ||
                            (condition !== undefined && !condition.data.active) ||
                            (condition !== undefined && condition.data.value.value < 1)) {

                                i.removeClass('active');
                                v.attr('style', 'display:none')
                                    .text('0');

                        } else if (condition !== undefined && condition.data.value.value > 0) {
                            // Update the value

                            v.text(condition.data.value.value);
                        }
                    } else {
                        if (condition !== undefined && (
                            condition.data.active && condition.data.value.value > 0)) {

                                i.addClass('active');
                                v.removeAttr('style')
                                    .text(condition.data.value.value);
                        }
                    }
                } else {
                    // Toggle condition

                    if (i.hasClass('active')) {
                        // icon is active.
                        if (condition === undefined ||
                            (condition !== undefined && !condition.data.active)) {
                                // Remove active if no effect was found
                                // Or effect was found, but not active.

                                i.removeClass('active');
                        }
                    } else {
                        if (condition !== undefined && (
                            condition.data.active)) {

                                i.addClass('active');
                        }
                    }
                }
            }
        }
    }

    /**
     * Show the Status Effect name and summary on mouseover of the token HUD
     */
    static _showStatusDescr(event) {
        const f = $(event.currentTarget);
        const statusDescr = $("div.status-effect-summary")
        if (f.attr("src").includes(CONFIG.PF2eStatusEffects.effectsIconFolder)) {
            const statusName = PF2eStatusEffects._getStatusFromImg(f.attr("src"));
            statusDescr.text( PF2e.DB.condition[statusName].name ).toggleClass("active");
        }
    }

    /**
     * Adding the Actors statuseffects to the newly created token.
     */
    static _hookOnCreateToken(scene, tokenData) {
        PF2eStatusEffects._updateToken(canvas.tokens.get(tokenData._id));
    }

    /**
     * Updating all tokens on the canvas with the actors status effects.
     */
    static _hookOnCanvasReady(canvas) {
        const scene = canvas.scene;      
        const tokenUpdates = [];
        
        for (let tokenData of scene.data.tokens) {
            // Only do this for tokens that are linked to their Actors
            if (tokenData.actorLink) {
                PF2eStatusEffects._updateToken(canvas.tokens.get(tokenData._id));
            }
        }
    }


    /**
     * A click event handler to increment or decrement valued conditions.
     *
     * @param event    The window click event
     */
    static async _setStatusValue(event) {
        event.preventDefault();
        let token : any = this;
        
        if (event.shiftKey) {
            PF2eStatusEffects._onToggleOverlay(event, token);
            return;
        }

        const f = $(event.currentTarget);
        const status = f.attr('data-condition');

        let updateHud = false;

        if (event.type == 'contextmenu') {
            // Right click, remove
            if (event.ctrlKey) {
                // CTRL key pressed.
                // Remove all conditions.
                updateHud = await PF2eStatusEffects._removeCondition(token, status, true);
            } else {
                updateHud = await PF2eStatusEffects._decrementConditionValue(token, status);
            }
        } else if (event.type == 'click') {
            updateHud = await PF2eStatusEffects._incrementConditionValue(token, status);
        }

        if (updateHud) {
            PF2eStatusEffects._updateHUD(f.parent().parent(), token); 
        }
    }

    

    static async _toggleStatus(event) {
        event.preventDefault();
        const token = this;
        if (event.shiftKey){
            PF2eStatusEffects._onToggleOverlay(event, token);
            return;
        }

        const f = $(event.currentTarget);
        const status = f.attr('data-condition');

        let updateHud = false;

        if (event.type == 'contextmenu') {
            // Right click, remove
            updateHud = await PF2eStatusEffects._removeCondition(token, status, event.ctrlKey);
        } else if (event.type == 'click') {
            updateHud = await PF2eStatusEffects._addCondition(token, status);
        }

        if (updateHud) {
            PF2eStatusEffects._updateHUD(f.parent(), token);
        }
    }

    /**
     * Recreating TokenHUD._onToggleOverlay. Handle assigning a status effect icon as the overlay effect
     */
    static _onToggleOverlay(event, token) {
        event.preventDefault();
        let f = $(event.currentTarget);
        token.toggleOverlay(f.attr("src"));
        f.siblings().removeClass("overlay");
        f.toggleClass("overlay");
    }

    /**
     * Creates a ChatMessage with the Actors current status effects.
     */
    static _createChatMessage(token, whisper = false) {
        let statusEffectList = ''
        let bubbleContent = ''

        // Get the active applied conditions.
        // Iterate the list to create the chat and bubble chat dialog.

        for (const condition of PF2eConditionManager.getAppliedConditions(token.actor.data.items.filter((i:ConditionData) => i.data.active && i.type === 'condition'))) {
            statusEffectList = statusEffectList + `
                <li><img src="${CONFIG.PF2eStatusEffects.effectsIconFolder + condition.data.hud.statusName +'.'+ CONFIG.PF2eStatusEffects.effectsIconFileType}" title="${PF2e.DB["condition"][condition.data.hud.statusName].summary}">
                    <span class="statuseffect-li">
                        <span class="statuseffect-li-text">${condition.name} ${(condition.data.value.isValued) ? condition.data.value.value : ''}</span>
                        <div class="statuseffect-rules"><h2>${condition.name}</h2>${condition.data.description.value}</div>
                    </span>
                </li>`;
            bubbleContent = bubbleContent + PF2e.DB["condition"][condition.data.hud.statusName].summary + ".<br>";
        }

        if (statusEffectList === '') {
            // No updates
            return;
        }

        const message = `
            <div class="dice-roll">
                <div class="dice-result">
                    <div class="dice-total statuseffect-message">
                        <ul>${statusEffectList}</ul>
                    </div>
                </div>
            </div>
        `;

        const chatData: any = {
            user: game.user._id,
            speaker: { alias: token.name+`'s status effects:` },
            content: message,
            type: CONST.CHAT_MESSAGE_TYPES.OTHER
        }
        if (whisper) chatData.whisper = ChatMessage.getWhisperRecipients("GM");
        ChatMessage.create(chatData);

        if (!token.data.hidden) {
            bubbleContent = PF2eStatusEffects._changeYouToI(bubbleContent);
            const panToSpeaker = game.settings.get("core", "chatBubblesPan");
            canvas.hud.bubbles.say(token, bubbleContent, {
                emote: true
            });
        }
    }

    /**
     * If the system setting statusEffectType is changed, we need to upgrade CONFIG 
     * And migrate all statusEffect URLs of all Tokens
     */
    static async _migrateStatusEffectUrls(chosenSetting) {
        if(CONFIG.PF2E.PF2eStatusEffects.overruledByModule) {
            console.log('PF2e System | The PF2eStatusEffect icons are overruled by a module');
            ui.notifications.error("Changing this setting has no effect, as the icon types are overruled by a module.", {permanent: true});
            return;
        }
        console.log('PF2e System | Changing status effect icon types');
        const iconType = PF2eStatusEffects.SETTINGOPTIONS.iconTypes[chosenSetting];
        const lastIconType = PF2eStatusEffects.SETTINGOPTIONS.iconTypes[CONFIG.PF2eStatusEffects.lastIconType];

        for (let scene of game.scenes.values()) {
            const tokenUpdates = [];

            for (let tokenData of scene.data.tokens) {
                const update = duplicate(tokenData);
                for (let url of tokenData.effects) {
                    if(url.includes(lastIconType.effectsIconFolder)) {
                        const statusName = this._getStatusFromImg(url);
                        const newUrl = iconType.effectsIconFolder + statusName +'.'+ iconType.effectsIconFileType;
                        console.log("PF2e System | Migrating effect "+statusName+" of Token "+tokenData.name+" on scene "
                                    +scene.data.name+" | '"+url+"' to '"+newUrl+"'");
                        const index = update.effects.indexOf(url);
                        if (index > -1) {
                            update.effects.splice(index, 1, newUrl);
                        }
                    }
                }
                tokenUpdates.push(update);
            }
            await scene.updateEmbeddedEntity("Token", tokenUpdates);
        }

        CONFIG.PF2eStatusEffects.effectsIconFolder = iconType.effectsIconFolder;
        CONFIG.PF2eStatusEffects.effectsIconFileType = iconType.effectsIconFileType;
        CONFIG.PF2eStatusEffects.lastIconType = chosenSetting;
        PF2eStatusEffects._updateStatusIcons();
    }

    /**
     * Helper to change condition summary info from YOU to I
     */
    static _changeYouToI(content) {
        content = content.replace(/you’re/g,"I’m");
        content = content.replace(/You’re/g,"I’m");
        // content = content.replace(/’re/g,"’m");
        content = content.replace(/Your/g,"My");
        content = content.replace(/your/g,"my");
        content = content.replace(/You are/g,"I am");
        content = content.replace(/you are/g,"I am");
        content = content.replace(/You can’t/g,"I can’t");
        content = content.replace(/you can’t/g,"I can’t");
        content = content.replace(/You can/g,"I can");
        content = content.replace(/you can/g,"I can");
        content = content.replace(/You have/g,"I have");
        content = content.replace(/you have/g,"I have");
        content = content.replace(/You/g,"I");
        content = content.replace(/you/g,"me");
        return content;
    }

    /**
     * Helper to get status effect name from image url
     */
    static _getStatusFromImg(url) {
        return url.substring(url.lastIndexOf('/')+1, (url.length - CONFIG.PF2eStatusEffects.effectsIconFileType.length-1) );
    }

    /**
     * Adds a condition to a token.
     *
     * @param {Token} token      The token to add the condition to.
     * @param {String} name      The name of the condition to add.
     * @param {Number} [value]   (Optional) A value to apply.
     * @return {Boolean}         Whether an update was made.
     */
    static async _addCondition(token, name:string, value?:number) {
        let needsUpdate = false;

        const condition = token.actor.data.items.find(i => i.type === 'condition' && i.name === name && i.data.sources.hud);
        
        if (!condition) {
            // Status does not exist, add it.

            let entity = duplicate(PF2eConditionManager.getCondition(name));

            entity.data.sources.hud = true;
            
            if (value) {
                entity.data.value.value = value;
            }

            await token.actor.createEmbeddedEntity('OwnedItem', entity);
            needsUpdate = true;

            console.log(`PF2e System | Adding condition '${name}'.`);
        }

        if (needsUpdate) {
            PF2eStatusEffects._updateToken(token);
        }

        return needsUpdate;
    }

    /**
     * Removes a condition from a token.
     *
     * @param {Token} token                    The token to remove the condition from.
     * @param {String} name                    The name of the condition to remove.
     * @param {Boolean} [ignoreSource=false]   Ignore HUD only conditions. Default: false
     * @return {Boolean}                       Whether an update was made.
     */
    static async _removeCondition(token, name:string, ignoreSource:boolean=false) {
        let needsUpdate = false;

        const conditions:Array<ConditionData> = (ignoreSource) ?
            token.actor.data.items.filter((i:ConditionData) => i.type === 'condition' && i.data.base === name):
            token.actor.data.items.filter((i:ConditionData) => i.type === 'condition' && i.name === name && i.data.sources.hud);

        for (const condition of conditions) {
            if (!ignoreSource && condition.data.sources.values.length > 0) {
                // This condition is applied from another condition.
                // Do not remove
    
                continue;
            }
    
            if (condition._id) {
                await token.actor.deleteEmbeddedEntity('OwnedItem', condition._id);
                needsUpdate = true;
    
                console.log(`PF2e System | Removing condition '${name}'.`);
            }
        }

        

        if (needsUpdate) {
            PF2eStatusEffects._updateToken(token);
        }

        return needsUpdate;
    }

    /**
     * Increments a condition with a value by a step value.
     *
     * @param {Token} token       The token to apply the condition changes to.
     * @param {String} name       The name of the condition to increment.
     * @param {Number} [step=1]   The number of units to increment the value by.  Default 1.
     * @return {Boolean}          Whether an update was made.
     */
    static async _incrementConditionValue(token, name:string, step:number=1) {
        const condition:ConditionData = token.actor.data.items.find((i:ConditionData) => i.type === 'condition' && i.name === name && i.data.sources.hud);

        if (condition) {
            return await PF2eStatusEffects._updateConditionValue(token, name, condition.data.value.value + step);
        } else {
            return await PF2eStatusEffects._updateConditionValue(token, name, 1);
        }
    }

    /**
     * Decrements a condition with a value by a step value.
     *
     * @param {Token} token       The token to apply the condition changes to.
     * @param {String} name       The name of the condition to decrement.
     * @param {Number} [step=1]   The number of units to decrement the value by.  Default 1.
     * @return {Boolean}          Whether an update was made.
     */
    static async _decrementConditionValue(token, name:string, step:number=1) {
        if (token.actor.data.items.some((i:ConditionData) => i.type === 'condition' && i.name === name && i.data.sources.hud)) {
            return await PF2eStatusEffects._incrementConditionValue(token, name, -step);
        }
    }

    /**
     * Sets the value of a condition.
     *
     * @param {Token} token    The token to apply the condition changes to.
     * @param {String} name    The name of the condition to change.
     * @param {Number} value   The number of units to decrement the value by.  Default 1.
     * @return {Boolean}       Whether an update was made.
     */
    static async _updateConditionValue(token, name:string, value:number) {
        const condition:ConditionData = token.actor.data.items.find(i => i.type === 'condition' && i.name === name && i.data.sources.hud);

        if (condition) {
            if (value === 0) {
                // Value is zero, remove the status.
                return await PF2eStatusEffects._removeCondition(token, name);
            } else {
                // Apply new value.
                const update = duplicate(condition);
                update.data.value.value = value;

                await token.actor.updateEmbeddedEntity("OwnedItem", update);

                console.log(`PF2e System | Setting condition '${name}' to ${value}.`);

                await PF2eStatusEffects._updateToken(token);

                return true;
            }
        } else {
            // Does not have condition,
            // Add one.
            if (value > 0) {
                return await PF2eStatusEffects._addCondition(token, name, 1);
            }
        }

        return false;
    }

    /**
     * Updates the token effect data from the set of conditions and non-condition effects.
     *
     * @param {Token} token    The token to update status effects.
     */
    static async _updateToken(token) {
        let updates = duplicate(token.data);

        updates.effects = [];

        // Get a list of status that are not conditions.
        const statuses:Array<string> = token.data.effects.filter(
            item => Array.from<string>(PF2eConditionManager.statusNames).map(
                status => CONFIG.PF2eStatusEffects.effectsIconFolder + status +'.'+ CONFIG.PF2eStatusEffects.effectsIconFileType
            ).indexOf(item) < 0
        );

        for (const condition of PF2eConditionManager.getAppliedConditions(token.actor.data.items.filter((i:ConditionData) => i.data.active && i.type === 'condition'))) {
            const url = CONFIG.PF2eStatusEffects.effectsIconFolder + condition.data.hud.statusName +'.'+ CONFIG.PF2eStatusEffects.effectsIconFileType;
            updates.effects.push(url);
        }

        // Dedup the effect list to make sure a status icon only displays once.
        let newSet = [...new Set(updates.effects)].concat(statuses);

        // See if any effects were added or removed
        // and only update the token if they have been.
        let added = newSet.filter(item => token.data.effects.indexOf(item) < 0);
        let removed = token.data.effects.filter(item => newSet.indexOf(item) < 0);

        if (added.length > 0 || removed.length > 0) {
            updates.effects = newSet;
            token.statusEffectChanged = true;

            await token.update(updates);
        }
    }



    /**
     * Add status effects to a token
     * Legacy function
     */
    static async setStatus(token, effects = []) {
        const conditions = Array.from(PF2eConditionManager.conditions);

        for (const status of Object.values(effects)) {
            const statusName = status.name;
            const value = status.value;

            const conditionFilter = conditions.filter(c => c.data.data.hud.statusName === statusName);

            if (conditionFilter.length === 0) {
                console.log(`PF2e System | '${statusName}' is not a vaild condition!`);
                continue;
            }
            const condition = conditionFilter.pop();

            const effect = token.actor.data.items.find(i => i.type === 'condition' && i.data.data.hud.statusName === statusName);

            if (typeof(value) === "string" && condition.data.data.value.isValued) {
                let newValue = 0;
                if (effect) {
                    if (value.startsWith("+") || value.startsWith("-"))
                        newValue = Number(effect.data.data.value.value) + Number(value);
                    else
                        newValue = Number(value);

                    if (isNaN(newValue)) continue;

                    await PF2eStatusEffects._updateConditionValue(token, condition.name, newValue);
                } else {
                    if (Number(value) > 0) {
                        await PF2eStatusEffects._updateConditionValue(token, condition.name, Number(value));
                    }
                }
            } else if (!value) {
                if (effect !== undefined && status.toggle){
                    await PF2eStatusEffects._removeCondition(token, condition.name);
                } else if (!effect) {
                    await PF2eStatusEffects._addCondition(token, condition.name);
                }
            }
        }
        this._createChatMessage(token);
    }
}

/**
* Setting a hook on TokenHUD.clear(), which clears the HUD by fading out it's active HTML and recording the new display state.
* The hook call passes the TokenHUD and Token objects.
*/
TokenHUD.prototype.clear = function() {
    BasePlaceableHUD.prototype.clear.call(this);
    Hooks.call("onTokenHUDClear", this, this.object);
}

Hooks.once("ready", function() { //or init?
    PF2eStatusEffects.init();
});