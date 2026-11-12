/**
 * Keeps Magic Items passive effects injected on their host items in sync. See magic-item-effects.js.
 */
import LinkedItemResolver from './link-resolver.js';
import { MODULE_ID } from './settings.js';
import { TOGGLES_FLAG, getInjectedRef, isInjectedEffect, isMagicItemHost, isMagicItemsActive } from './magic-item-effects.js';

function isFeatureCandidate(item) {
	return item instanceof CONFIG.Item.documentClass && !item.isEmbedded;
}

function hostChanged(item) {
	if (!isMagicItemsActive()) return;
	if (isMagicItemHost(item)) LinkedItemResolver.refreshMagicItemEffects(item);
	else if (isFeatureCandidate(item)) LinkedItemResolver.refreshMagicItemFeature(item);
}

function itemDeleted(item) {
	if (!isMagicItemsActive() || !isFeatureCandidate(item)) return;
	LinkedItemResolver.refreshMagicItemFeature(item, { deleted: true });
}

function featureEffectChanged(effect) {
	if (!isMagicItemsActive() || !isFeatureCandidate(effect.parent)) return;
	LinkedItemResolver.refreshMagicItemFeature(effect.parent);
}

function actorCreated(actor) {
	if (!isMagicItemsActive()) return;
	for (const item of actor.items.contents) if (isMagicItemHost(item)) LinkedItemResolver.refreshMagicItemEffects(item);
}

/**
 * Injected effects only exist in memory, so a toggle is stored on the host item instead,
 * and every other edit is refused: the effect is defined on the feature.
 */
function preUpdateEffect(effect, changes) {
	if (!isInjectedEffect(effect)) return;
	// Foundry also sends unchanged fields such as `_id` and `type`; only real changes count.
	const source = effect._source ?? {};
	const keys = Object.entries(foundry.utils.flattenObject(changes))
		.filter(([key, value]) => key !== '_id' && !foundry.utils.objectsEqual({ v: foundry.utils.getProperty(source, key) }, { v: value }))
		.map(([key]) => key);
	const host = effect.parent;
	if (keys.length === 1 && keys[0] === 'disabled' && host instanceof CONFIG.Item.documentClass) {
		host.update({ [`flags.${MODULE_ID}.${TOGGLES_FLAG}.${effect.id}.disabled`]: Boolean(changes.disabled) });
	} else {
		ui.notifications?.warn(`${effect.name} comes from a Magic Items feature. Edit it on the feature itself.`);
	}
	return false;
}

function preDeleteEffect(effect) {
	if (!isInjectedEffect(effect)) return;
	ui.notifications?.warn(`${effect.name} comes from a Magic Items feature. Remove the feature from the item instead.`);
	return false;
}

/**
 * Without Midi-QOL, Magic Items offers a button that copies all of a feature's effects onto the actor,
 * passive ones included. Refuse a copy of an effect this module already applies passively.
 */
function preCreateEffect(effect, data) {
	if (!isMagicItemsActive()) return;
	const actor = effect.parent;
	if (!(actor instanceof CONFIG.Actor.documentClass)) return;
	const featureId = /\.Item\.([^.]+)$/.exec(data?.origin ?? '')?.[1];
	if (!featureId || actor.items.get(featureId)) return;
	for (const item of actor.items.contents) {
		const duplicate = item.effects?.find((fx) => {
			const ref = getInjectedRef(fx);
			return ref && ref.feature.split('.').at(-1) === featureId && fx.name === data.name;
		});
		if (!duplicate) continue;
		ui.notifications?.info(`${data.name} is already applied passively by ${item.name}.`);
		return false;
	}
}

/** -------------------------------------------- */
Hooks.on('createItem', hostChanged);
Hooks.on('updateItem', hostChanged);
Hooks.on('deleteItem', itemDeleted);
Hooks.on('createActiveEffect', featureEffectChanged);
Hooks.on('updateActiveEffect', featureEffectChanged);
Hooks.on('deleteActiveEffect', featureEffectChanged);
Hooks.on('createActor', actorCreated);
Hooks.on('preCreateActiveEffect', preCreateEffect);
Hooks.on('preUpdateActiveEffect', preUpdateEffect);
Hooks.on('preDeleteActiveEffect', preDeleteEffect);
