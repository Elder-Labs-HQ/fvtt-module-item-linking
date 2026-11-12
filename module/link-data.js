import { MODULE_ID, getSetting } from './settings.js';
import { keepPropertiesOverride } from './system.js';
import { deletionKeys } from './utils.js';

const ALWAYS_LOCAL = [
	`flags.${MODULE_ID}`,
	'flags.beavers-crafting',
	// Set on each copy when it is created, never on the template.
	'flags.core.sourceId',
	'_id',
	'_stats',
	'ownership',
	'folder',
	'sort',
];

function splitPath(path) {
	return path.split('.').filter((p) => p !== '');
}

function isObject(value) {
	return foundry.utils.getType(value) === 'Object';
}

function normalizedUpdatePath(path) {
	return path
		.split('.')
		.map((p) => (p.startsWith('-=') ? p.slice(2) : p))
		.join('.');
}

function pathMatches(path, rule) {
	return path === rule || path.startsWith(`${rule}.`) || rule.startsWith(`${path}.`);
}

export function getLocalPaths(keepEmbedded, itemData) {
	const additional = getSetting('linkHeader') ? [] : ['name', 'img'];
	const exceptions = getSetting('linkPropertyExceptions');
	return [
		...ALWAYS_LOCAL,
		...keepPropertiesOverride(itemData),
		...additional,
		...(exceptions !== '' ? exceptions.split(',').map((p) => p.trim()).filter(Boolean) : []),
		...(keepEmbedded ? Object.values(CONFIG.Item.documentClass.metadata.embedded) : []),
	];
}

export function removeLocalProperties(changes, itemData, keepEmbedded = true) {
	const keys = getLocalPaths(keepEmbedded, itemData);
	for (const key of keys) {
		const parts = splitPath(key);
		let target = changes;
		for (const [idx, part] of parts.entries()) {
			const type = foundry.utils.getType(target);
			if (!(type === 'Object' || type === 'Array')) break;
			if (!(part in target)) break;
			if (idx + 1 === parts.length) delete target[part];
			else target = target[part];
		}
	}
	return changes;
}

function getPath(source, path) {
	if (path in source) return source[path];
	return foundry.utils.getProperty(source, path);
}

function setPath(target, path, value) {
	if (path in target) target[path] = value;
	else foundry.utils.setProperty(target, path, value);
}

export function pickLocalProperties(source, itemData = source, keepEmbedded = true) {
	const picked = {};
	for (const path of getLocalPaths(keepEmbedded, itemData)) {
		const value = getPath(source, path);
		if (value !== undefined) setPath(picked, path, foundry.utils.deepClone(value));
	}
	return picked;
}

// Effect definitions stay linked, but toggles belong to each actor's copy.
function preserveEffectDisabled(itemData, inherited) {
	if (!Array.isArray(itemData.effects) || !Array.isArray(inherited.effects)) return;
	const localById = new Map(itemData.effects.filter((effect) => effect._id).map((effect) => [effect._id, effect]));
	for (const effect of inherited.effects) {
		const local = localById.get(effect._id);
		if (typeof local?.disabled === 'boolean') effect.disabled = local.disabled;
	}
}

export function createChanges(itemData, baseItemData, ignoreEmbedded = true, { preserveEffectState = false } = {}) {
	const source = removeLocalProperties(foundry.utils.deepClone(itemData), itemData, true);
	const baseItemSource = removeLocalProperties(foundry.utils.deepClone(baseItemData), itemData, ignoreEmbedded);
	if (preserveEffectState && !ignoreEmbedded) preserveEffectDisabled(itemData, baseItemSource);
	const diff = foundry.utils.diffObject(source, baseItemSource);
	const deletions = deletionKeys(source, baseItemSource);
	return foundry.utils.mergeObject(deletions, diff);
}

function rewriteEmbeddedOrigins(source, origin) {
	if (!origin) return source;
	for (const collection of Object.values(CONFIG.Item.documentClass.metadata.embedded)) {
		if (!Array.isArray(source[collection])) continue;
		for (const embedded of source[collection]) {
			if ('origin' in embedded) embedded.origin = origin;
		}
	}
	return source;
}

export function createEffectiveSource(itemData, baseItemData, keepEmbedded = true, { origin, preserveEffectState = false } = {}) {
	const effective = foundry.utils.deepClone(baseItemData);
	const local = pickLocalProperties(itemData, itemData, keepEmbedded);
	foundry.utils.mergeObject(effective, local, {
		inplace: true,
		insertKeys: true,
		insertValues: true,
		overwrite: true,
		performDeletions: true,
	});
	if (preserveEffectState && !keepEmbedded) preserveEffectDisabled(itemData, effective);
	return rewriteEmbeddedOrigins(effective, origin);
}

/**
 * @param {string[]} [options.removedPaths] - Paths already removed from the copy in memory because the template
 *   no longer has them. The saved copy may still hold them, so they are deleted unless the template has them again.
 */
export function createUnlinkUpdate(itemData, baseItemData, { origin, preserveEffectState = false, removedPaths = [] } = {}) {
	const materialized = createEffectiveSource(itemData, baseItemData, false, { origin, preserveEffectState });
	const update = foundry.utils.flattenObject(materialized);
	// Keys the template no longer has must be deleted from the unlinked item, not left behind.
	Object.assign(update, foundry.utils.flattenObject(deletionKeys(itemData, materialized)));
	const deleted = removedPaths.filter((path) => foundry.utils.getProperty(materialized, path) === undefined);
	for (const path of deleted) {
		// Deleting an ancestor already removes this path; a nested deletion would recreate the ancestor empty.
		if (deleted.some((other) => path.startsWith(`${other}.`))) continue;
		const parts = path.split('.');
		update[[...parts.slice(0, -1), `-=${parts.at(-1)}`].join('.')] = null;
	}
	update[`flags.${MODULE_ID}.baseItem`] = itemData.flags?.[MODULE_ID]?.baseItem ?? null;
	update[`flags.${MODULE_ID}.isLinked`] = false;
	return update;
}

export function filterUpdateToLocal(changes, itemData, { allowLinkFlags = true } = {}) {
	const localPaths = getLocalPaths(true, itemData);
	const flat = foundry.utils.flattenObject(foundry.utils.expandObject(changes));
	const filtered = {};
	for (const [path, value] of Object.entries(flat)) {
		const normalized = normalizedUpdatePath(path);
		if (path === '_id') {
			filtered[path] = value;
			continue;
		}
		if (allowLinkFlags && normalized.startsWith(`flags.${MODULE_ID}`)) {
			filtered[path] = value;
			continue;
		}
		if (localPaths.some((rule) => pathMatches(normalized, rule))) {
			filtered[path] = value;
		}
	}
	return foundry.utils.expandObject(filtered);
}

export function replaceObjectContents(target, source) {
	for (const key of Object.keys(target)) delete target[key];
	for (const [key, value] of Object.entries(source)) target[key] = value;
	return target;
}

export function isEmptyUpdate(update) {
	return !update || Object.keys(foundry.utils.flattenObject(update)).length === 0;
}

export function mergePendingUpdate(itemData, changes) {
	const pending = foundry.utils.deepClone(itemData);
	const expanded = foundry.utils.expandObject(foundry.utils.deepClone(changes));
	return foundry.utils.mergeObject(pending, expanded, {
		inplace: true,
		insertKeys: true,
		insertValues: true,
		overwrite: true,
		performDeletions: true,
	});
}

export function hasLinkFlagUpdate(changes) {
	return isObject(changes.flags?.[MODULE_ID]) || Object.keys(foundry.utils.flattenObject(changes)).some((key) =>
		key.startsWith(`flags.${MODULE_ID}.`)
	);
}
