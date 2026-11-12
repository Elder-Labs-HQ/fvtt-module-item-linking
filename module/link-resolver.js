import { MODULE_ID } from './settings.js';
import { createEffectiveSource, createUnlinkUpdate, mergePendingUpdate } from './link-data.js';
import { getLocalItemSource, isPrimaryItem } from './utils.js';
import {
	getMagicItemFeatureUuids,
	isMagicItemHost,
	isMagicItemsActive,
	keepInjectedEffects,
	syncInjectedEffects,
} from './magic-item-effects.js';
import Logger from './lib/Logger.js';

class LinkedItemResolver {
	static #baseSources = new Map();
	static #basePromises = new Map();

	static isLinked(item) {
		return Boolean(item?.getFlag?.(MODULE_ID, 'isLinked') && item?.getFlag?.(MODULE_ID, 'baseItem'));
	}

	static getBaseUuid(item) {
		return item?.getFlag?.(MODULE_ID, 'baseItem') ?? null;
	}

	static getCachedBaseSource(uuid) {
		return this.#baseSources.get(uuid) ?? null;
	}

	static setCachedBaseSource(item) {
		if (!item?.uuid || !item?._source) return null;
		const source = foundry.utils.deepClone(item._source);
		this.#baseSources.set(item.uuid, source);
		return source;
	}

	static invalidate(uuid) {
		if (!uuid) return;
		this.#baseSources.delete(uuid);
		this.#basePromises.delete(uuid);
	}

	static async getBaseItem(uuid) {
		if (!uuid) return null;
		if (this.#basePromises.has(uuid)) return this.#basePromises.get(uuid);
		const promise = fromUuid(uuid)
			.then((item) => {
				if (item) this.setCachedBaseSource(item);
				return item;
			})
			.catch((err) => {
				Logger.warn(`Failed to retrieve linked base item ${uuid}`, false, err);
				return null;
			})
			.finally(() => this.#basePromises.delete(uuid));
		this.#basePromises.set(uuid, promise);
		return promise;
	}

	static async getBaseSource(uuid) {
		if (!uuid) return null;
		const cached = this.getCachedBaseSource(uuid);
		if (cached) return cached;
		const item = await this.getBaseItem(uuid);
		return item?._source ? foundry.utils.deepClone(item._source) : null;
	}

	static getActorItems() {
		const tokens = (game.scenes?.contents ?? [])
			.map((s) => s.tokens.contents.filter((t) => t.isLinked === false && t.actor).map((t) => t.actor))
			.flat();
		return [...(game.actors?.values() ?? []), ...tokens]
			.map((a) => a.items.contents)
			.flat()
			.filter(Boolean);
	}

	static getLinkedItems() {
		const items = game.items?.contents ?? [];
		return [...items, ...this.getActorItems()].filter((item) => this.isLinked(item) && isPrimaryItem(item));
	}

	static async hydrateItem(item, { render = false } = {}) {
		if (!this.isLinked(item) || item.compendium) return false;
		const baseUuid = this.getBaseUuid(item);
		const baseSource = await this.getBaseSource(baseUuid);
		if (!baseSource) return false;
		this.applyBaseSource(item, baseSource);
		if (render) this.renderItem(item);
		return true;
	}

	static hydrateItemFromCache(item, { render = false, loadMissing = true } = {}) {
		if (!this.isLinked(item) || item.compendium) return false;
		const baseSource = this.getCachedBaseSource(this.getBaseUuid(item));
		if (!baseSource) return false;
		this.applyBaseSource(item, baseSource, { loadMissing });
		if (render) this.renderItem(item);
		return true;
	}

	static applyBaseSource(item, baseSource, { loadMissing = true } = {}) {
		const localSource = getLocalItemSource(item);
		const effective = createEffectiveSource(localSource, baseSource, false, {
			origin: item.uuid,
			preserveEffectState: item.parent instanceof CONFIG.Actor.documentClass,
		});
		// Magic Items effects are injected after linking; keep them so the diff does not remove them.
		keepInjectedEffects(item._source, effective);
		const changes = foundry.utils.diffObject(item._source, effective, { deletionKeys: true });
		let changed = false;
		if (!foundry.utils.isEmpty(changes)) {
			item.updateSource(changes, { recursive: true });
			item.prepareFinalAttributes?.();
			changed = true;
		}
		// The base item may have changed the Magic Item tab, so the injected set is recomputed here too.
		if (this.syncMagicItemEffects(item, { loadMissing })) changed = true;
		return changed;
	}

	static #getCachedFeature = (uuid) => this.getCachedBaseSource(uuid);

	/**
	 * Syncs a host item's Magic Items effects from cached feature sources. Uncached features keep their current
	 * effects until loaded; they are loaded asynchronously when `loadMissing` is set, followed by another sync.
	 * @returns {boolean} Whether the host's injected effects changed.
	 */
	static syncMagicItemEffects(item, { loadMissing = true, keepMissing = true } = {}) {
		if (!isMagicItemHost(item)) return false;
		const { changed, missing } = syncInjectedEffects(item, this.#getCachedFeature, { keepMissing });
		if (changed) this.resetOwner(item);
		if (loadMissing && missing.length) this.refreshMagicItemEffects(item);
		return changed;
	}

	/**
	 * Loads every feature a host item lists, then syncs its injected effects.
	 * @returns {Promise<boolean>} Whether the host's injected effects changed.
	 */
	static async refreshMagicItemEffects(item, { render = true } = {}) {
		if (!isMagicItemHost(item)) return false;
		await Promise.all(getMagicItemFeatureUuids(item._source).map((uuid) => this.getBaseSource(uuid)));
		const { changed } = syncInjectedEffects(item, this.#getCachedFeature);
		if (changed) {
			this.resetOwner(item);
			if (render) this.renderItem(item);
		}
		return changed;
	}

	static getMagicItemHosts(featureUuid = null) {
		return this.getActorItems().filter(
			(item) =>
				isMagicItemHost(item) &&
				(featureUuid === null || getMagicItemFeatureUuids(item._source).includes(featureUuid))
		);
	}

	static async refreshAllMagicItemEffects() {
		if (!isMagicItemsActive()) return 0;
		const hosts = this.getMagicItemHosts();
		const uuids = new Set(hosts.flatMap((item) => getMagicItemFeatureUuids(item._source)));
		await Promise.all([...uuids].map((uuid) => this.getBaseSource(uuid)));
		let count = 0;
		// Everything is loaded now, so features that are still missing no longer exist.
		for (const item of hosts) if (this.syncMagicItemEffects(item, { loadMissing: false, keepMissing: false })) count++;
		return count;
	}

	/**
	 * Re-reads a feature after it or its effects change, then refreshes every host that lists it.
	 */
	static async refreshMagicItemFeature(feature, { deleted = false } = {}) {
		if (!feature?.uuid) return 0;
		const hosts = this.getMagicItemHosts(feature.uuid);
		if (!hosts.length) return 0;
		if (deleted) this.invalidate(feature.uuid);
		else this.setCachedBaseSource(feature);
		const results = await Promise.all(hosts.map((item) => this.refreshMagicItemEffects(item)));
		return results.filter(Boolean).length;
	}

	/**
	 * Re-prepares the actor that owns an item, so changed transfer effects apply.
	 */
	static resetOwner(item) {
		const owner = item.parent;
		if (owner instanceof CONFIG.Actor.documentClass) owner.reset?.();
		else item.reset?.();
	}

	static async hydrateAll({ render = false } = {}) {
		const linked = this.getLinkedItems();
		const baseUuids = new Set(linked.map((item) => this.getBaseUuid(item)).filter(Boolean));
		await Promise.all([...baseUuids].map((uuid) => this.getBaseSource(uuid)));
		// Magic Items features load once afterwards, in refreshAllMagicItemEffects.
		for (const item of linked) this.hydrateItemFromCache(item, { render, loadMissing: false });
		return linked.length;
	}

	static async hydrateDerivations(baseUuid, { render = true } = {}) {
		if (!baseUuid) return 0;
		const baseSource = await this.getBaseSource(baseUuid);
		if (!baseSource) return 0;
		let count = 0;
		for (const item of this.getLinkedItems()) {
			if (this.getBaseUuid(item) !== baseUuid) continue;
			if (this.applyBaseSource(item, baseSource)) count++;
			if (render) this.renderItem(item);
		}
		return count;
	}

	static async refreshBaseItem(baseItem, { render = true } = {}) {
		if (!baseItem?.uuid) return 0;
		this.invalidate(baseItem.uuid);
		this.setCachedBaseSource(baseItem);
		return this.hydrateDerivations(baseItem.uuid, { render });
	}

	static async createUnlinkUpdate(item, changes = {}) {
		const expandedChanges = foundry.utils.expandObject(foundry.utils.deepClone(changes));
		const baseUuid = expandedChanges.flags?.[MODULE_ID]?.baseItem ?? this.getBaseUuid(item);
		const pending = mergePendingUpdate(getLocalItemSource(item), changes);
		const baseSource = await this.getBaseSource(baseUuid);
		if (!baseSource) {
			const update = foundry.utils.flattenObject(pending);
			update[`flags.${MODULE_ID}.baseItem`] = baseUuid ?? null;
			update[`flags.${MODULE_ID}.isLinked`] = false;
			return update;
		}
		return createUnlinkUpdate(pending, baseSource, {
			origin: item.uuid,
			preserveEffectState: item.parent instanceof CONFIG.Actor.documentClass,
		});
	}

	static renderItem(item) {
		item.sheet?.rendered && item.sheet.render(false);
		item.parent?.sheet?.rendered && item.parent.sheet.render(false);
	}
}

export default LinkedItemResolver;
