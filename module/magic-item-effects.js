/**
 * Passive effects for Magic Items features.
 *
 * The Magic Items module never puts its features on the actor; it builds a temporary item each time one is
 * used, so their passive (transfer) effects never apply. Like linked items, we materialize those effects in
 * memory only: they are copied into the host item's source (the item that owns the Magic Item tab) and never
 * written to the database. Foundry then applies them as the host item's own transfer effects.
 */
import { MODULE_ID } from './settings.js';

// The module was renamed from "magic-items-2" to "magicitems" (v4); both use their id as the flag scope.
export const MAGIC_ITEMS_IDS = ['magicitems', 'magic-items-2'];
// Marks an injected effect: flags.item-linking.magicItemEffect = { feature, effect }.
export const INJECTED_FLAG = 'magicItemEffect';
// Per-host toggles, keyed by injected effect id: flags.item-linking.magicItemEffects.<id>.disabled.
export const TOGGLES_FLAG = 'magicItemEffects';

const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function isMagicItemsActive() {
	return MAGIC_ITEMS_IDS.some((id) => game.modules?.get(id)?.active);
}

export function getMagicItemData(source) {
	for (const id of MAGIC_ITEMS_IDS) {
		const data = source?.flags?.[id];
		if (data && typeof data === 'object') return data;
	}
	return null;
}

function entries(collection) {
	if (!collection || typeof collection !== 'object') return [];
	return Object.values(collection).filter((entry) => entry && typeof entry === 'object');
}

function entryUuid(entry) {
	if (typeof entry.uuid === 'string' && entry.uuid) return entry.uuid;
	if (!entry.id) return null;
	const pack = (entry.pack ?? 'world').replace(/^magic-items-2\./, 'magicitems.');
	return pack === 'world' ? `Item.${entry.id}` : `Compendium.${pack}.Item.${entry.id}`;
}

/**
 * The UUIDs of every feature and spell listed on a Magic Item tab, in order and without duplicates.
 */
export function getMagicItemFeatureUuids(source) {
	const data = getMagicItemData(source);
	if (!data) return [];
	const uuids = [...entries(data.feats), ...entries(data.spells)].map(entryUuid).filter(Boolean);
	return [...new Set(uuids)];
}

/**
 * Mirrors Magic Items' own rule: enabled, plus equipped/attuned when the tab requires it.
 */
export function isMagicItemActive(source) {
	const data = getMagicItemData(source);
	if (!data?.enabled) return false;
	if (data.equipped && !source.system?.equipped) return false;
	if (data.attuned && !(source.system?.attunement === 2 || source.system?.attuned === true)) return false;
	return true;
}

function hash32(text, seed) {
	let h = (0x811c9dc5 ^ seed) >>> 0;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	h ^= h >>> 16;
	h = Math.imul(h, 0x85ebca6b);
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35);
	h ^= h >>> 16;
	return h >>> 0;
}

/**
 * A stable 16-character document id for an injected effect. It depends only on the source feature and effect,
 * so the same effect keeps its id (and its toggle) across reloads and when the host item moves between actors.
 */
export function injectedEffectId(featureUuid, effectId) {
	const key = `${featureUuid}#${effectId}`;
	let id = '';
	for (let seed = 0; id.length < 16; seed++) {
		let h = hash32(key, seed);
		for (let i = 0; i < 4 && id.length < 16; i++) {
			id += ID_CHARS[h % ID_CHARS.length];
			h = Math.floor(h / ID_CHARS.length);
		}
	}
	return id;
}

export function getInjectedRef(effect) {
	const flags = effect?._source?.flags ?? effect?.flags;
	return flags?.[MODULE_ID]?.[INJECTED_FLAG] ?? null;
}

export function isInjectedEffect(effect) {
	return Boolean(getInjectedRef(effect));
}

/**
 * Removes injected effects from serialized item data, so copies, exports and transfers never persist them.
 */
export function stripInjectedEffects(data) {
	if (Array.isArray(data?.effects)) data.effects = data.effects.filter((effect) => !isInjectedEffect(effect));
	return data;
}

/**
 * Carries the host's current injected effects into a freshly computed linked source, so re-linking does not
 * wipe them. Any injected copies already present in the computed source are replaced, not duplicated.
 */
export function keepInjectedEffects(currentSource, effective) {
	if (!Array.isArray(effective?.effects)) return effective;
	const injected = (currentSource?.effects ?? []).filter(isInjectedEffect);
	effective.effects = [...effective.effects.filter((effect) => !isInjectedEffect(effect)), ...foundry.utils.deepClone(injected)];
	return effective;
}

export function isMagicItemHost(item) {
	if (!item?._source || item.compendium) return false;
	if (!(item.parent instanceof CONFIG.Actor.documentClass)) return false;
	return Boolean(getMagicItemData(item._source)) || (item._source.effects ?? []).some(isInjectedEffect);
}

function cleanEffect(data) {
	const cls = CONFIG.ActiveEffect?.documentClass;
	return cls?.cleanData ? cls.cleanData(data) : data;
}

/**
 * Builds the effects a host item should carry from the cached sources of its features.
 * @param {Item} item - The host item.
 * @param {(uuid: string) => object|null} getSource - Returns a cached feature source, or null if not loaded.
 * @param {object} [options]
 * @param {boolean} [options.keepMissing=false] - Keep the current effects of features that are not cached,
 *   because a load is still pending. Without it, those effects are removed.
 * @returns {{effects: object[], missing: string[]}} The injected effects and the feature UUIDs not in cache.
 */
export function buildInjectedEffects(item, getSource, { keepMissing = false } = {}) {
	const source = item._source;
	const result = { effects: [], missing: [] };
	if (!isMagicItemsActive() || !isMagicItemActive(source)) return result;
	const toggles = source.flags?.[MODULE_ID]?.[TOGGLES_FLAG] ?? {};
	for (const uuid of getMagicItemFeatureUuids(source)) {
		const feature = getSource(uuid);
		if (!feature) {
			result.missing.push(uuid);
			if (keepMissing) {
				const pending = (source.effects ?? []).filter((effect) => getInjectedRef(effect)?.feature === uuid);
				result.effects.push(...foundry.utils.deepClone(pending));
			}
			continue;
		}
		for (const effect of feature.effects ?? []) {
			if (!effect?._id || effect.transfer !== true || effect.type === 'enchantment') continue;
			const copy = foundry.utils.deepClone(effect);
			copy._id = injectedEffectId(uuid, effect._id);
			copy.origin = item.uuid;
			const toggle = toggles[copy._id]?.disabled;
			if (typeof toggle === 'boolean') copy.disabled = toggle;
			copy.flags ??= {};
			copy.flags[MODULE_ID] = { ...(copy.flags[MODULE_ID] ?? {}), [INJECTED_FLAG]: { feature: uuid, effect: effect._id } };
			result.effects.push(cleanEffect(copy));
		}
	}
	return result;
}

/**
 * Brings a host item's injected effects in line with its features. In-memory only.
 * @returns {{changed: boolean, missing: string[]}}
 */
export function syncInjectedEffects(item, getSource, { keepMissing = false } = {}) {
	if (!isMagicItemHost(item)) return { changed: false, missing: [] };
	const { effects: next, missing } = buildInjectedEffects(item, getSource, { keepMissing });
	const all = item._source.effects ?? [];
	const current = all.filter(isInjectedEffect);
	const currentById = new Map(current.map((effect) => [effect._id, effect]));
	const unchanged =
		current.length === next.length && next.every((effect) => foundry.utils.objectsEqual(currentById.get(effect._id), effect));
	if (unchanged) return { changed: false, missing };
	// Non-recursive so injected effects that no longer apply are removed from the embedded collection.
	const effects = [...all.filter((effect) => !isInjectedEffect(effect)), ...next];
	item.updateSource({ effects }, { recursive: false });
	return { changed: true, missing };
}
