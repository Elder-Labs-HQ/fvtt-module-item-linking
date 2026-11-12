import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './foundry-fixture.js';

const passive = { _id: 'passiveEffect001', name: 'Spinning Guard', type: 'base', transfer: true, disabled: false, changes: [{ key: 'system.attributes.ac.bonus', mode: 2, value: '1' }] };
const onUse = { _id: 'onUseEffect00001', name: 'Spinning Death', transfer: false, disabled: false, changes: [] };
const own = { _id: 'ownEffect0000001', name: 'Scythe Edge', transfer: true, disabled: false, changes: [] };

async function setup({ magicItems = true, magic = {}, system = {}, linked = false } = {}) {
	const fx = await fixture();
	if (magicItems) fx.game.modules.set('magicitems', { active: true });
	const helpers = await fx.load('magic-item-effects.js');
	const feature = new fx.Item({ _id: 'feature0000001', name: 'Spinning', type: 'feat', effects: [structuredClone(passive), structuredClone(onUse)] });
	fx.documents.set(feature.uuid, feature);
	const flags = { magicitems: { enabled: true, feats: { 0: { uuid: feature.uuid, id: feature.id, pack: 'world', name: 'Spinning' } }, ...magic } };
	const hostSource = { _id: 'scythe00000001', name: 'Scythe', type: 'weapon', system, flags, effects: [structuredClone(own)] };
	let base = null;
	if (linked) {
		base = new fx.Item(structuredClone(hostSource));
		base.uuid = 'Compendium.world.weapons.Item.scythe00000001';
		base.compendium = 'world.weapons';
		fx.documents.set(base.uuid, base);
		fx.resolver.setCachedBaseSource(base);
		hostSource.flags['item-linking'] = { isLinked: true, baseItem: base.uuid };
	}
	const actor = new fx.Actor({ _id: 'actor', items: [hostSource] });
	fx.game.actors.set(actor.id, actor);
	const host = actor.items.get(hostSource._id);
	const injectedId = helpers.injectedEffectId(feature.uuid, passive._id);
	const injected = () => host._source.effects.find((effect) => effect._id === injectedId);
	return { fx, helpers, feature, base, actor, host, injectedId, injected };
}

test('injected ids are stable, valid document ids that depend only on the feature and effect', async () => {
	const { helpers } = await setup();
	const id = helpers.injectedEffectId('Compendium.world.feats.Item.abc', 'effect1');
	assert.match(id, /^[A-Za-z0-9]{16}$/);
	assert.equal(helpers.injectedEffectId('Compendium.world.feats.Item.abc', 'effect1'), id);
	assert.notEqual(helpers.injectedEffectId('Compendium.world.feats.Item.abc', 'effect2'), id);
	assert.notEqual(helpers.injectedEffectId('Compendium.world.feats.Item.abd', 'effect1'), id);
});

test('a feature passive effect is injected onto its host; on-use effects are left to Magic Items', async () => {
	const { fx, feature, actor, host, injected } = await setup();
	assert.equal(await fx.resolver.refreshAllMagicItemEffects(), 1);
	assert.equal(injected().transfer, true);
	assert.equal(injected().origin, host.uuid);
	assert.equal(injected().changes[0].value, '1');
	assert.deepEqual(injected().flags['item-linking'].magicItemEffect, { feature: feature.uuid, effect: passive._id });
	assert.equal(host._source.effects.some((effect) => effect.name === onUse.name), false);
	assert(host._source.effects.some((effect) => effect._id === own._id));
	assert.equal(actor.resets, 1);
	assert.equal(await fx.resolver.refreshAllMagicItemEffects(), 0, 'an unchanged sync is a no-op');
	assert.equal(actor.resets, 1);
});

test('nothing is injected when Magic Items is inactive or the item tab is disabled', async () => {
	let ctx = await setup({ magicItems: false });
	await ctx.fx.resolver.refreshMagicItemEffects(ctx.host);
	assert.equal(ctx.injected(), undefined);
	ctx = await setup({ magic: { enabled: false } });
	await ctx.fx.resolver.refreshMagicItemEffects(ctx.host);
	assert.equal(ctx.injected(), undefined);
});

test('equipped and attuned requirements follow the Magic Items rule and remove effects when unmet', async () => {
	const { fx, host, injected } = await setup({ magic: { equipped: true, attuned: true }, system: { equipped: false, attuned: false } });
	await fx.resolver.refreshMagicItemEffects(host);
	assert.equal(injected(), undefined);
	host._source.system.equipped = true;
	host._source.system.attuned = true;
	await fx.resolver.refreshMagicItemEffects(host);
	assert(injected());
	host._source.system.equipped = false;
	await fx.resolver.refreshMagicItemEffects(host);
	assert.equal(injected(), undefined);
	assert(host._source.effects.some((effect) => effect._id === own._id));
});

test('serializing the host never includes injected effects', async () => {
	const { fx, host, injected } = await setup();
	await fx.resolver.refreshMagicItemEffects(host);
	assert(injected());
	const data = host.toObject();
	assert.deepEqual(data.effects.map((effect) => effect._id), [own._id]);
});

test('a toggle is stored on the host and survives the next sync; other edits and deletes are refused', async () => {
	const { fx, host, injectedId, injected } = await setup();
	await fx.load('magic-items.js');
	await fx.resolver.refreshMagicItemEffects(host);
	const effect = { id: injectedId, name: passive.name, _source: injected(), parent: host };
	const [preUpdate] = fx.hooks.get('preUpdateActiveEffect');
	// Foundry v12 also sends the unchanged `type`.
	assert.equal(preUpdate(effect, { _id: injectedId, disabled: true, type: 'base' }), false);
	assert.deepEqual({ ...host.updates.at(-1) }, { [`flags.item-linking.magicItemEffects.${injectedId}.disabled`]: true });
	await fx.resolver.refreshMagicItemEffects(host);
	assert.equal(injected().disabled, true);
	const updates = host.updates.length;
	assert.equal(preUpdate(effect, { name: 'Renamed' }), false);
	assert.equal(host.updates.length, updates);
	const [preDelete] = fx.hooks.get('preDeleteActiveEffect');
	assert.equal(preDelete(effect), false);
	assert.equal(fx.notifications.length, 2);
	assert.equal(preUpdate({ _source: own, parent: host }, { disabled: true }), undefined, 'own effects are untouched');
});

test('editing the feature effect refreshes every host that lists it', async () => {
	const { fx, feature, host, injected } = await setup();
	await fx.load('magic-items.js');
	await fx.resolver.refreshMagicItemEffects(host);
	feature._source.effects[0].changes[0].value = '3';
	for (const hook of fx.hooks.get('updateActiveEffect')) hook({ parent: feature });
	await new Promise(setImmediate);
	assert.equal(injected().changes[0].value, '3');
	fx.documents.delete(feature.uuid);
	for (const hook of fx.hooks.get('deleteItem')) hook(feature);
	await new Promise(setImmediate);
	assert.equal(injected(), undefined);
});

test('linked hosts keep injected effects through re-linking and follow tab changes on the base item', async () => {
	const { fx, base, host, injected } = await setup({ linked: true });
	await fx.resolver.refreshMagicItemEffects(host);
	await fx.resolver.hydrateItem(host);
	assert(injected());
	assert.equal(host._source.effects.filter((effect) => effect._id === injected()._id).length, 1);
	assert(host._source.effects.some((effect) => effect._id === own._id));
	// A value change, not a key removal: Foundry's diffObject never propagates removed keys to linked copies.
	base._source.flags.magicitems.enabled = false;
	await fx.resolver.refreshBaseItem(base, { render: false });
	assert.equal(injected(), undefined);
	assert(host._source.effects.some((effect) => effect._id === own._id));
});

test('an explicit whole-effects exception does not duplicate injected effects', async () => {
	const { fx, host, injected } = await setup({ linked: true });
	fx.settings.linkPropertyExceptions = 'effects';
	await fx.resolver.refreshMagicItemEffects(host);
	await fx.resolver.hydrateItem(host);
	assert.equal(host._source.effects.filter((effect) => effect._id === injected()._id).length, 1);
});

test("Magic Items' apply button cannot stack a copy of an effect that is already applied passively", async () => {
	const { fx, feature, actor, host } = await setup();
	await fx.load('magic-items.js');
	await fx.resolver.refreshMagicItemEffects(host);
	const [preCreate] = fx.hooks.get('preCreateActiveEffect');
	const origin = `${actor.uuid}.Item.${feature.id}`;
	assert.equal(preCreate({ parent: actor }, { name: passive.name, origin }), false);
	assert.equal(preCreate({ parent: actor }, { name: onUse.name, origin }), undefined);
	assert.equal(preCreate({ parent: actor }, { name: passive.name, origin: host.uuid }), undefined, 'real items are never blocked');
});

test('duplicating an actor does not persist injected effects', async () => {
	const { fx, actor, host } = await setup();
	await fx.load('actor.js');
	for (const ready of fx.hooks.get('ready') ?? []) await ready();
	await fx.resolver.refreshMagicItemEffects(host);
	// In Foundry an actor's source shares its items' sources, so it carries the injected effects.
	const source = structuredClone({ ...actor._source, items: actor.items.contents.map((item) => item._source) });
	assert(source.items[0].effects.length > 1);
	const copy = await fx.Actor.create(source, {});
	assert.deepEqual(copy.items.get(host.id)._source.effects.map((effect) => effect._id), [own._id]);
});

test('a feature that is only uncached keeps its effects until loading confirms it is gone', async () => {
	const { fx, feature, host, injected } = await setup({ linked: true });
	await fx.resolver.refreshMagicItemEffects(host);
	fx.resolver.invalidate(feature.uuid);
	fx.resolver.syncMagicItemEffects(host, { loadMissing: false });
	assert(injected(), 'kept while the feature is not cached');
	fx.documents.delete(feature.uuid);
	await fx.resolver.refreshMagicItemEffects(host);
	assert.equal(injected(), undefined);
});
