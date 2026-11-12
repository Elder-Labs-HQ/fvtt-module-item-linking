import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './foundry-fixture.js';

const BASE_UUID = 'Compendium.world.items.Item.template00000001';

function template() {
	return {
		_id: 'template00000001',
		name: 'Template',
		type: 'weapon',
		system: { description: { value: 'Base' } },
		flags: { someModule: { kept: 1, removed: 2, list: { 0: { name: 'entry' } } } },
		effects: [],
	};
}

async function setup(copyFlags = {}) {
	const fx = await fixture();
	const base = new fx.Item(template());
	base.uuid = BASE_UUID;
	base.compendium = 'world.items';
	fx.documents.set(base.uuid, base);
	fx.resolver.setCachedBaseSource(base);
	const local = template();
	local._id = 'copy000000000001';
	local.flags = { ...local.flags, ...copyFlags, 'item-linking': { isLinked: true, baseItem: BASE_UUID } };
	const actor = new fx.Actor({ _id: 'actor', items: [local] });
	fx.game.actors.set(actor.id, actor);
	return { fx, base, item: actor.items.get(local._id) };
}

test('a key removed from the template is removed from linked copies on refresh', async () => {
	const { fx, base, item } = await setup();
	delete base._source.flags.someModule.removed;
	await fx.resolver.refreshBaseItem(base, { render: false });
	assert.equal(item._source.flags.someModule.removed, undefined);
	assert.equal(item._source.flags.someModule.kept, 1);
});

test('an object emptied on the template is emptied on linked copies', async () => {
	const { fx, base, item } = await setup();
	base._source.flags.someModule.list = {};
	await fx.resolver.refreshBaseItem(base, { render: false });
	assert.deepEqual({ ...item._source.flags.someModule.list }, {});
});

test('a whole flag scope removed from the template is removed from linked copies', async () => {
	const { fx, base, item } = await setup();
	delete base._source.flags.someModule;
	await fx.resolver.refreshBaseItem(base, { render: false });
	assert.equal(item._source.flags.someModule, undefined);
});

test('per-copy flags that the template never has are kept', async () => {
	const { fx, base, item } = await setup({
		dnd5e: { sourceId: 'Compendium.dnd5e.classfeatures.Item.x', advancementOrigin: 'class.adv' },
		core: { sourceId: 'Compendium.dnd5e.items.Item.y' },
	});
	await fx.resolver.refreshBaseItem(base, { render: false });
	assert.equal(item._source.flags.dnd5e.sourceId, 'Compendium.dnd5e.classfeatures.Item.x');
	assert.equal(item._source.flags.dnd5e.advancementOrigin, 'class.adv');
	assert.equal(item._source.flags.core.sourceId, 'Compendium.dnd5e.items.Item.y');
	assert.equal(item._source.flags['item-linking'].baseItem, BASE_UUID);
});

test('unlinking persists keys removed from the template as deletions', async () => {
	const { fx, base, item } = await setup();
	delete base._source.flags.someModule.removed;
	fx.resolver.setCachedBaseSource(base);
	const update = await fx.resolver.createUnlinkUpdate(item);
	assert.equal(update['flags.someModule.-=removed'], null);
	assert.equal('flags.someModule.-=removed' in update, true);
	assert.equal(update['flags.someModule.kept'], 1);
	assert.equal(update['flags.item-linking.isLinked'], false);
});

test('unlinking after a refresh still deletes the keys the refresh removed in memory', async () => {
	const { fx, base, item } = await setup();
	delete base._source.flags.someModule.removed;
	base._source.flags.someModule.list = {};
	await fx.resolver.refreshBaseItem(base, { render: false });
	// The saved copy still has them, but the in-memory source no longer does.
	assert.equal(item._source.flags.someModule.removed, undefined);
	const update = await fx.resolver.createUnlinkUpdate(item);
	assert.equal('flags.someModule.-=removed' in update, true);
	assert.equal('flags.someModule.list.-=0' in update, true);
	assert.equal(update['flags.someModule.kept'], 1);
});

test('a key the template removes and later adds back is not deleted on unlink', async () => {
	const { fx, base, item } = await setup();
	delete base._source.flags.someModule.removed;
	await fx.resolver.refreshBaseItem(base, { render: false });
	base._source.flags.someModule.removed = 3;
	await fx.resolver.refreshBaseItem(base, { render: false });
	const update = await fx.resolver.createUnlinkUpdate(item);
	assert.equal('flags.someModule.-=removed' in update, false);
	assert.equal(update['flags.someModule.removed'], 3);
});

test('when a whole scope is removed, unlink deletes only the scope', async () => {
	const { fx, base, item } = await setup();
	delete base._source.flags.someModule.removed;
	await fx.resolver.refreshBaseItem(base, { render: false });
	delete base._source.flags.someModule;
	await fx.resolver.refreshBaseItem(base, { render: false });
	const update = await fx.resolver.createUnlinkUpdate(item);
	assert.equal('flags.-=someModule' in update, true);
	assert.equal(Object.keys(update).some((key) => key.startsWith('flags.someModule.')), false);
});
