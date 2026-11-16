import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './foundry-fixture.js';

const oldUuid = 'Compendium.world.old-items.Item.template';
const destination = { pack: 'world.new-items', keepId: true, relink: true };
const inventoryItem = (id, baseItem = oldUuid, isLinked = true) => ({
	_id: id, name: id, system: { quantity: 3 },
	flags: { 'item-linking': { baseItem, isLinked, custom: 'preserved' } },
});

const linksOf = (items) => items
	.filter((item) => item.flags['item-linking'].isLinked)
	.map((item) => item.flags['item-linking'].baseItem)
	.sort();

/**
 * A world Actor pack mock. `links` is the summary stored on each actor and its index entry:
 * 'auto' mirrors the actor's inventory, null means the actor was never synced.
 */
function actorPack(fx, collection, sources, { locked = false, links = 'auto', event = 'load actors' } = {}) {
	const pack = {
		collection, documentName: 'Actor', locked, metadata: { packageType: 'world' },
		actors: new Map(), index: new Map(), cache: new Map(), queries: [],
		has: (id) => pack.cache.has(id),
		get: (id) => pack.cache.get(id),
		async getDocuments(query = {}) {
			fx.events.push(event);
			pack.queries.push(query._id__in);
			return query._id__in.map((id) => pack.actors.get(id));
		},
		async configure() { assert.fail('compendium lock state was changed'); },
	};
	for (const source of sources) {
		const summary = links === 'auto' ? linksOf(source.items) : links;
		const flags = summary ? { 'item-linking': { links: summary } } : {};
		const actor = new fx.Actor({ ...source, flags });
		actor.compendium = pack;
		pack.actors.set(actor.id, actor);
		pack.index.set(actor.id, structuredClone({ _id: actor.id, flags }));
	}
	fx.game.packs.set(collection, pack);
	return pack;
}

async function moveFixture({ locked = false, items = [inventoryItem('linked')], links = 'auto' } = {}) {
	const fx = await fixture();
	const events = [];
	const notifications = [];
	fx.events = events;
	fx.context.foundry.utils.debounce = (callback) => callback;
	fx.context.ui = { notifications: Object.fromEntries(['info', 'warn', 'error'].map((level) => [
		level, (message) => notifications.push({ level, message }),
	])) };
	fx.game.packs = new Map();
	Object.defineProperty(fx.Actor.prototype, 'flags', { get() { return this._source.flags; } });
	fx.Actor.updateDocuments = async (updates, { pack }) => {
		events.push(`sync ${updates.map((update) => update._id).join(', ')}`);
		for (const { _id, ...changes } of updates) fx.mergeObject(fx.game.packs.get(pack).actors.get(_id)._source, changes);
	};
	const pack = actorPack(fx, 'world.logged-off-players', [{ _id: 'stored-actor', items }], { locked, links });
	const actor = pack.actors.get('stored-actor');
	for (const item of actor.items.values()) {
		item.compendium = pack;
		item.setFlag = async (scope, key, value) => {
			assert.equal(pack.locked, false);
			// Persistence must finish before deletion, not just start before it.
			await new Promise((resolve) => setImmediate(resolve));
			fx.mergeObject(item._source, { [`flags.${scope}.${key}`]: value });
			events.push(`update ${item.id}`);
			return item;
		};
	}
	const targetPack = {
		collection: destination.pack,
		getUuid: (id) => `Compendium.${destination.pack}.Item.${id}`,
	};
	fx.game.packs.set(targetPack.collection, targetPack);
	const template = new fx.Item({ _id: 'template', name: 'Template', flags: {} });
	template.uuid = oldUuid;
	template.toCompendium = () => template._source;
	fx.Item.create = async (_data, options) => {
		events.push('create destination');
		return { uuid: targetPack.getUuid(options.keepId ? template.id : 'generated-id') };
	};
	template.delete = async () => { events.push('delete source'); };
	const moves = await fx.load('moveToAnotherCompendium.js');
	return { ...fx, ...moves, actor, pack, template, events, notifications, targetPack, processor: {} };
}

test('single move updates loaded world items and unopened unlocked world actor packs before deleting the source', async () => {
	const fx = await moveFixture({ items: [
		inventoryItem('linked'), inventoryItem('disabled', oldUuid, false), inventoryItem('other', 'another-uuid'),
	] });
	const worldActor = new fx.Actor({ _id: 'world-actor', items: [inventoryItem('world-linked')] });
	const worldItem = worldActor.items.get('world-linked');
	worldItem.setFlag = async (scope, key, value) => {
		await new Promise((resolve) => setImmediate(resolve));
		fx.mergeObject(worldItem._source, { [`flags.${scope}.${key}`]: value });
		fx.events.push('update world');
	};
	fx.game.actors.set(worldActor.id, worldActor);
	const before = structuredClone(fx.actor.items.get('linked')._source);
	await fx.moveItem(fx.template, destination, fx.processor);
	const newUuid = fx.targetPack.getUuid('template');
	before.flags['item-linking'].baseItem = newUuid;
	assert.deepEqual(fx.actor.items.get('linked')._source, before);
	assert.equal(worldItem.getFlag('item-linking', 'baseItem'), newUuid);
	assert.equal(fx.actor.items.get('disabled').getFlag('item-linking', 'baseItem'), oldUuid);
	assert.equal(fx.actor.items.get('other').getFlag('item-linking', 'baseItem'), 'another-uuid');
	assert.deepEqual(fx.events, ['load actors', 'create destination', 'update world', 'update linked', 'delete source']);
	assert.equal(fx.pack.locked, false);
	assert.equal(fx.processor.label, 'Moving item... 100%');
});

test('single move uses the created UUID when keeping document IDs is disabled', async () => {
	const fx = await moveFixture({ locked: false });
	await fx.moveItem(fx.template, { ...destination, keepId: false }, fx.processor);
	assert.equal(fx.actor.items.get('linked').getFlag('item-linking', 'baseItem'), fx.targetPack.getUuid('generated-id'));
	assert.equal(fx.pack.locked, false);
	assert(!fx.events.includes('unlock'));
	assert(!fx.events.includes('lock'));
});

test('a failed inventory update preserves the lock state and retains the original item', async () => {
	const fx = await moveFixture();
	fx.actor.items.get('linked').setFlag = async () => { throw new Error('write failed'); };
	await assert.rejects(fx.moveItem(fx.template, destination, fx.processor), /write failed/);
	assert.equal(fx.pack.locked, false);
	assert.deepEqual(fx.events, ['load actors', 'create destination']);
});

test('relink disabled skips actor packs and their inventory updates', async () => {
	const fx = await moveFixture();
	fx.pack.getDocuments = () => assert.fail('actor pack was scanned');
	await fx.moveItem(fx.template, { ...destination, relink: false }, fx.processor);
	assert.equal(fx.actor.items.get('linked').getFlag('item-linking', 'baseItem'), oldUuid);
	assert.deepEqual(fx.events, ['create destination', 'delete source']);
});

test('no matching links leaves actor inventory unchanged without loading the actor', async () => {
	const fx = await moveFixture({ items: [inventoryItem('unrelated', 'another-uuid')] });
	await fx.moveItem(fx.template, destination, fx.processor);
	assert.deepEqual(fx.events, ['create destination', 'delete source']);
	assert.equal(fx.pack.locked, false);
	assert.equal(fx.actor.items.get('unrelated').getFlag('item-linking', 'baseItem'), 'another-uuid');
});

test('actor pack load errors abort before creating a copy or deleting the source', async () => {
	const fx = await moveFixture();
	fx.pack.getDocuments = async () => { throw new Error('read failed'); };
	await assert.rejects(fx.moveItem(fx.template, destination, fx.processor), /read failed/);
	assert.deepEqual(fx.events, []);
});

test('locked world Actor packs, module/system Actor packs, and non-Actor packs are never loaded', async () => {
	const fx = await moveFixture();
	for (const [collection, documentName, packageType, locked] of [
		['world.locked-actors', 'Actor', 'world', true],
		['module.actors', 'Actor', 'module', false],
		['system.actors', 'Actor', 'system', false],
		['world.items', 'Item', 'world', false],
		['world.journals', 'JournalEntry', 'world', false],
	]) {
		fx.game.packs.set(collection, {
			collection, documentName, metadata: { packageType }, locked,
			getDocuments() { assert.fail(`${collection} was scanned`); },
			configure() { assert.fail(`${collection} lock state was changed`); },
		});
	}
	await fx.moveItem(fx.template, destination, fx.processor);
	assert.equal(fx.actor.items.get('linked').getFlag('item-linking', 'baseItem'), fx.targetPack.getUuid('template'));
});

test('a locked world Actor pack with matching links is skipped', async () => {
	const fx = await moveFixture({ locked: true });
	fx.pack.getDocuments = () => assert.fail('locked pack was scanned');
	await fx.moveItem(fx.template, destination, fx.processor);
	assert.equal(fx.actor.items.get('linked').getFlag('item-linking', 'baseItem'), oldUuid);
	assert.equal(fx.pack.locked, true);
	assert.deepEqual(fx.events, ['create destination', 'delete source']);
});

test('every unlocked world Actor pack is scanned without relying on collection IDs', async () => {
	const fx = await moveFixture();
	const second = actorPack(fx, 'world.arbitrary-name', [
		{ _id: 'second-actor', items: [inventoryItem('second-inventory')] },
	], { event: 'load second actors' });
	const secondItem = second.actors.get('second-actor').items.get('second-inventory');
	secondItem.setFlag = async (scope, key, value) => {
		fx.mergeObject(secondItem._source, { [`flags.${scope}.${key}`]: value });
	};
	await fx.moveItem(fx.template, destination, fx.processor);
	assert.equal(secondItem.getFlag('item-linking', 'baseItem'), fx.targetPack.getUuid('template'));
	assert.equal(fx.actor.items.get('linked').getFlag('item-linking', 'baseItem'), fx.targetPack.getUuid('template'));
	assert.equal(fx.events.filter((event) => event === 'load second actors').length, 1);
});

test('only archived actors whose summary lists the moved item are loaded', async () => {
	const fx = await moveFixture();
	const archive = actorPack(fx, 'world.archive', [
		{ _id: 'holder', items: [inventoryItem('held')] },
		{ _id: 'unrelated', items: [inventoryItem('other', 'another-uuid')] },
		{ _id: 'empty', items: [] },
	]);
	archive.actors.get('holder').items.get('held').setFlag = async () => { fx.events.push('update held'); };
	await fx.moveItem(fx.template, destination, fx.processor);
	assert.deepEqual(archive.queries.map((ids) => [...ids]), [['holder']]);
	assert(fx.events.includes('update held'));
});

test('never-synced archived actors are loaded, relinked and get their summary repaired', async () => {
	const fx = await moveFixture({ links: null });
	await fx.moveItem(fx.template, destination, fx.processor);
	assert.deepEqual(fx.events, ['load actors', 'sync stored-actor', 'create destination', 'update linked', 'delete source']);
	assert.deepEqual([...fx.actor.flags['item-linking'].links], [oldUuid]);
	assert.equal(fx.actor.items.get('linked').getFlag('item-linking', 'baseItem'), fx.targetPack.getUuid('template'));
});

test('archived actors already in the pack cache are reused instead of reloaded', async () => {
	const fx = await moveFixture();
	fx.pack.cache.set(fx.actor.id, fx.actor);
	fx.pack.getDocuments = () => assert.fail('cached actor was reloaded');
	await fx.moveItem(fx.template, destination, fx.processor);
	assert.equal(fx.actor.items.get('linked').getFlag('item-linking', 'baseItem'), fx.targetPack.getUuid('template'));
});

test('a pack locked after scanning aborts relinking without unlocking it or deleting the source', async () => {
	const fx = await moveFixture();
	const create = fx.Item.create;
	fx.Item.create = async (...args) => { fx.pack.locked = true; return create(...args); };
	await assert.rejects(fx.moveItem(fx.template, destination, fx.processor), /was locked during the move/);
	assert.equal(fx.pack.locked, true);
	assert.deepEqual(fx.events, ['load actors', 'create destination']);
});

async function folderFixture() {
	const secondUuid = 'Compendium.world.old-items.Item.second';
	const fx = await moveFixture({ items: [inventoryItem('linked'), inventoryItem('second-link', secondUuid)] });
	const sourcePack = {
		getUuid: (id) => `Compendium.world.old-items.Item.${id}`,
		async getDocuments({ folder }) { return [{ id: folder === 'root' ? 'template' : 'second' }]; },
	};
	fx.context.Folder = { async create() { return { id: 'target-folder' }; } };
	fx.folder = {
		id: 'root', name: 'Folder', compendium: sourcePack,
		children: [{ folder: { id: 'child', compendium: sourcePack, children: [] } }],
		async exportToCompendium() { fx.events.push('export folder'); },
		async delete(options) {
			assert.equal(options.deleteSubfolders, true);
			assert.equal(options.deleteContents, true);
			fx.events.push('delete folder');
		},
	};
	return fx;
}

test('folder moves scan unlocked world actors once and relink items from the folder and its children', async () => {
	const fx = await folderFixture();
	assert.equal(await fx.moveFolder(fx.folder, destination, fx.processor), true);
	assert.equal(fx.actor.items.get('linked').getFlag('item-linking', 'baseItem'), fx.targetPack.getUuid('template'));
	assert.equal(fx.actor.items.get('second-link').getFlag('item-linking', 'baseItem'), fx.targetPack.getUuid('second'));
	assert.deepEqual(fx.events, ['load actors', 'export folder', 'update linked', 'update second-link', 'delete folder']);
	assert.equal(fx.processor.label, 'Moving folder... 100%');
});

test('folder update failures preserve the lock state and retain the source folder', async () => {
	const fx = await folderFixture();
	fx.actor.items.get('linked').setFlag = async () => { throw new Error('write failed'); };
	assert.equal(await fx.moveFolder(fx.folder, destination, fx.processor), false);
	assert.equal(fx.pack.locked, false);
	assert(!fx.events.includes('delete folder'));
	assert(fx.notifications.some(({ level }) => level === 'error'));
});
