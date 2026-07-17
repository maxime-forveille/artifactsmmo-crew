import { describe, expect, it } from 'vitest';

import type { CrewSnapshot } from '../src/bot/orchestration/crewSnapshot.js';
import {
  createGoalActivityPlanner,
  GoalItemNotResolvedError,
  GoalMonsterNotResolvedError,
  GoalResourceNotResolvedError,
  resolveEquipmentKnowledge,
} from '../src/bot/orchestration/goalActivityPlanner.js';
import type {
  ActiveGoal,
  EquipItemGoal,
  OrchestratorState,
  ProduceItemGoal,
  ReachCombatLevelGoal,
  ReachProfessionLevelGoal,
  ReplenishBankItemGoal,
} from '../src/bot/orchestration/orchestratorState.js';
import {
  InvalidResourceTargetError,
  type Resource,
} from '../src/bot/orchestration/resourceReplenishment.js';
import type { WorldKnowledge } from '../src/bot/orchestration/worldKnowledge.js';
import type { components } from '../src/client/schema.js';

type Character = components['schemas']['CharacterSchema'];
type Item = components['schemas']['ItemSchema'];
type Monster = components['schemas']['MonsterSchema'];

const buildCharacter = (name: string): Character => ({
  ...({} as Character),
  attack_air: 0,
  attack_earth: 10,
  attack_fire: 0,
  attack_water: 0,
  critical_strike: 0,
  hp: 100,
  inventory: [],
  level: 10,
  max_hp: 100,
  mining_level: 10,
  name,
  res_air: 0,
  res_earth: 0,
  res_fire: 0,
  res_water: 0,
  weapon_slot: 'wooden_stick',
  weaponcrafting_level: 10,
  woodcutting_level: 10,
});

const buildGoal = (
  id: string,
  itemCode: string,
): ActiveGoal & ReplenishBankItemGoal => ({
  id,
  itemCode,
  minimumBankQuantity: 50,
  origin: 'configured',
  type: 'replenishBankItem',
});

const buildEquipmentGoal = (): ActiveGoal & EquipItemGoal => ({
  characterName: 'Stan',
  id: 'equip-stan-dagger',
  itemCode: 'copper_dagger',
  origin: 'configured',
  type: 'equipItem',
});

const buildCombatGoal = (
  targetLevel = 11,
): ActiveGoal & ReachCombatLevelGoal => ({
  characterName: 'Stan',
  id: `reachCombatLevel:Stan:${targetLevel}`,
  origin: 'autonomous',
  reason: `Progress Stan to combat level ${targetLevel}`,
  rule: 'combatProgression',
  targetLevel,
  type: 'reachCombatLevel',
});

const buildProfessionGoal = (): ActiveGoal & ReachProfessionLevelGoal => ({
  characterName: 'Stan',
  id: 'reachProfessionLevel:Stan:weaponcrafting:10',
  origin: 'prerequisite',
  parentGoalId: 'equip-stan-dagger',
  reason: 'Reach the profession level required by the parent Goal',
  rule: 'professionProgression',
  skill: 'weaponcrafting',
  targetLevel: 10,
  type: 'reachProfessionLevel',
});

const buildItem = (): Item => ({
  ...({} as Item),
  code: 'copper_dagger',
  craft: { items: [], level: 5, quantity: 1, skill: 'weaponcrafting' },
  level: 5,
  type: 'weapon',
});

const buildProductionGoal = (): ActiveGoal & ProduceItemGoal => ({
  id: 'produceItem:copper_bar:2',
  itemCode: 'copper_bar',
  minimumBankQuantity: 2,
  origin: 'prerequisite',
  parentGoalId: 'reachProfessionLevel:Stan:weaponcrafting:10',
  reason: 'Craft an intermediate for the parent Goal',
  rule: 'professionProgression',
  type: 'produceItem',
});

const buildRawItem = (code: string): Item => ({ ...({} as Item), code });

const buildMonster = (itemCode: string): Monster => ({
  ...({} as Monster),
  attack_air: 0,
  attack_earth: 1,
  attack_fire: 0,
  attack_water: 0,
  code: 'yellow_slime',
  critical_strike: 0,
  drops: [
    { code: 'unrelated_drop', max_quantity: 1, min_quantity: 1, rate: 1 },
    { code: itemCode, max_quantity: 1, min_quantity: 1, rate: 1 },
  ],
  hp: 10,
  level: 2,
  name: 'Yellow Slime',
  res_air: 0,
  res_earth: 0,
  res_fire: 0,
  res_water: 0,
});

const buildResource = (
  code: string,
  itemCode: string,
  skill: Resource['skill'],
): Resource => ({
  code,
  drops: [
    { code: 'unrelated_drop', max_quantity: 1, min_quantity: 1, rate: 1 },
    { code: itemCode, max_quantity: 1, min_quantity: 1, rate: 1 },
  ],
  level: 1,
  name: code,
  skill,
});

const copperGoal = buildGoal('goal-copper', 'copper_ore');
const ashGoal = buildGoal('goal-ash', 'ash_wood');
const copperResource = buildResource('copper_rocks', 'copper_ore', 'mining');
const ashResource = buildResource('ash_tree', 'ash_wood', 'woodcutting');

const buildState = (
  goals: OrchestratorState['goals'] = [copperGoal, ashGoal],
): OrchestratorState => ({ goals, reservations: [] });

const buildSnapshot = (bank: CrewSnapshot['bank'] = []): CrewSnapshot => ({
  bank,
  capturedAt: '2026-07-15T12:00:00.000Z',
  characters: [buildCharacter('Stan')],
});

const buildKnowledge = (
  overrides: Partial<WorldKnowledge> = {},
): WorldKnowledge => ({ items: [], monsters: [], resources: [], ...overrides });

const buildPlanner = () =>
  createGoalActivityPlanner(
    buildKnowledge({ resources: [copperResource, ashResource] }),
  );

describe('createGoalActivityPlanner', () => {
  it('uses the resource resolved for the highest-priority Goal', () => {
    const result = buildPlanner()(buildSnapshot(), buildState());

    expect(result.isOk() && result.value.activities).toEqual([
      {
        activity: { resourceCode: 'copper_rocks', type: 'farmResource' },
        characterName: 'Stan',
        consumes: [],
        goalId: 'goal-copper',
        produces: [{ itemCode: 'copper_ore' }],
      },
    ]);
  });

  it('uses the monster resolved for a monster-backed replenishment Goal', () => {
    const monsterGoal = {
      ...copperGoal,
      monsterCode: 'yellow_slime',
      resourceCode: undefined,
    };
    const unrelatedMonster = {
      ...buildMonster('unrelated_drop'),
      code: 'chicken',
    };
    const planner = createGoalActivityPlanner(
      buildKnowledge({
        monsters: [unrelatedMonster, buildMonster('copper_ore')],
      }),
    );

    expect(
      planner(buildSnapshot(), buildState([monsterGoal]))._unsafeUnwrap(),
    ).toMatchObject({
      activities: [
        {
          activity: { monsterCode: 'yellow_slime', type: 'fightMonster' },
          characterName: 'Stan',
          goalId: 'goal-copper',
          produces: [{ itemCode: 'copper_ore' }],
        },
      ],
    });
  });

  it('returns a typed error when a configured monster source is unresolved', () => {
    const monsterGoal = {
      ...copperGoal,
      monsterCode: 'missing_slime',
      resourceCode: undefined,
    };
    const result = createGoalActivityPlanner(buildKnowledge())(
      buildSnapshot(),
      buildState([monsterGoal]),
    );

    expect(result._unsafeUnwrapErr()).toEqual(
      new GoalMonsterNotResolvedError('goal-copper'),
    );
  });

  it('skips a satisfied Goal and plans the next one from the same snapshot', () => {
    const result = buildPlanner()(
      buildSnapshot([{ code: 'copper_ore', quantity: 50 }]),
      buildState(),
    );

    expect(result.isOk() && result.value).toEqual({
      activities: [
        {
          activity: { resourceCode: 'ash_tree', type: 'farmResource' },
          characterName: 'Stan',
          consumes: [],
          goalId: 'goal-ash',
          produces: [{ itemCode: 'ash_wood' }],
        },
      ],
      state: { goals: [ashGoal], reservations: [] },
    });
  });

  it('uses different idle characters for simultaneous Goals', () => {
    const snapshot = {
      ...buildSnapshot(),
      characters: [buildCharacter('Stan'), buildCharacter('Cartman')],
    };

    const result = buildPlanner()(snapshot, buildState());

    expect(result.isOk() && result.value).toEqual({
      activities: [
        {
          activity: { resourceCode: 'copper_rocks', type: 'farmResource' },
          characterName: 'Cartman',
          consumes: [],
          goalId: 'goal-copper',
          produces: [{ itemCode: 'copper_ore' }],
        },
        {
          activity: { resourceCode: 'ash_tree', type: 'farmResource' },
          characterName: 'Stan',
          consumes: [],
          goalId: 'goal-ash',
          produces: [{ itemCode: 'ash_wood' }],
        },
      ],
      state: buildState(),
    });
  });

  it('completes a profession Goal and plans the next Goal from the same snapshot', () => {
    const professionGoal = buildProfessionGoal();
    const state = buildState([professionGoal, copperGoal]);

    expect(buildPlanner()(buildSnapshot(), state)._unsafeUnwrap()).toEqual({
      activities: [
        {
          activity: { resourceCode: 'copper_rocks', type: 'farmResource' },
          characterName: 'Stan',
          consumes: [],
          goalId: 'goal-copper',
          produces: [{ itemCode: 'copper_ore' }],
        },
      ],
      state: { goals: [copperGoal], reservations: [] },
    });
  });

  it('resolves a produceItem Goal against shared world knowledge and crafts it', () => {
    const productionGoal = buildProductionGoal();
    const barItem: Item = {
      ...({} as Item),
      code: 'copper_bar',
      craft: {
        items: [{ code: 'copper_ore', quantity: 2 }],
        level: 1,
        quantity: 1,
        skill: 'mining',
      },
    };
    const character = {
      ...buildCharacter('Stan'),
      inventory: [{ code: 'copper_ore', quantity: 4, slot: 0 }],
    };
    const planner = createGoalActivityPlanner(
      buildKnowledge({ items: [barItem] }),
    );
    const state = buildState([productionGoal]);

    expect(
      planner(
        { ...buildSnapshot(), characters: [character] },
        state,
      )._unsafeUnwrap(),
    ).toEqual({
      activities: [
        {
          activity: { itemCode: 'copper_bar', quantity: 2, type: 'craftItem' },
          characterName: 'Stan',
          consumes: [{ itemCode: 'copper_ore', quantity: 4 }],
          goalId: productionGoal.id,
          produces: [{ itemCode: 'copper_bar', quantity: 2 }],
        },
      ],
      state,
    });
  });

  it('returns a typed error when a produceItem Goal target is not resolved', () => {
    const productionGoal = buildProductionGoal();
    const state = buildState([productionGoal]);

    expect(buildPlanner()(buildSnapshot(), state)._unsafeUnwrapErr()).toEqual(
      new GoalItemNotResolvedError(productionGoal.id),
    );
  });

  it('plans combat before lower-priority resource work on another character', () => {
    const combatGoal = buildCombatGoal();
    const state = buildState([combatGoal, copperGoal]);
    const planner = createGoalActivityPlanner(
      buildKnowledge({
        monsters: [buildMonster('yellow_slimeball')],
        resources: [copperResource],
      }),
    );
    const snapshot = {
      ...buildSnapshot(),
      characters: [buildCharacter('Stan'), buildCharacter('Cartman')],
    };

    expect(planner(snapshot, state)._unsafeUnwrap()).toEqual({
      activities: [
        {
          activity: { monsterCode: 'yellow_slime', type: 'fightMonster' },
          characterName: 'Stan',
          consumes: [],
          goalId: combatGoal.id,
          produces: [],
        },
        {
          activity: { resourceCode: 'copper_rocks', type: 'farmResource' },
          characterName: 'Cartman',
          consumes: [],
          goalId: copperGoal.id,
          produces: [{ itemCode: 'copper_ore' }],
        },
      ],
      state,
    });
  });

  it('completes a combat Goal and plans the next Goal from the same snapshot', () => {
    const combatGoal = buildCombatGoal(10);
    const state = buildState([combatGoal, copperGoal]);
    const planner = createGoalActivityPlanner(
      buildKnowledge({
        monsters: [buildMonster('yellow_slimeball')],
        resources: [copperResource],
      }),
    );

    expect(planner(buildSnapshot(), state)._unsafeUnwrap()).toEqual({
      activities: [
        {
          activity: { resourceCode: 'copper_rocks', type: 'farmResource' },
          characterName: 'Stan',
          consumes: [],
          goalId: copperGoal.id,
          produces: [{ itemCode: 'copper_ore' }],
        },
      ],
      state: { goals: [copperGoal], reservations: [] },
    });
  });

  it('preserves global priority across equipment and resource Goals', () => {
    const equipmentGoal = buildEquipmentGoal();
    const state = buildState([equipmentGoal, copperGoal]);
    const planner = createGoalActivityPlanner(
      buildKnowledge({ items: [buildItem()], resources: [copperResource] }),
    );
    const snapshot = {
      ...buildSnapshot(),
      characters: [buildCharacter('Stan'), buildCharacter('Cartman')],
    };

    const result = planner(snapshot, state);

    expect(result._unsafeUnwrap()).toEqual({
      activities: [
        {
          activity: {
            itemCode: 'copper_dagger',
            quantity: 1,
            type: 'craftItem',
          },
          characterName: 'Stan',
          consumes: [],
          goalId: 'equip-stan-dagger',
          produces: [{ itemCode: 'copper_dagger', quantity: 1 }],
        },
        {
          activity: { resourceCode: 'copper_rocks', type: 'farmResource' },
          characterName: 'Cartman',
          consumes: [],
          goalId: 'goal-copper',
          produces: [{ itemCode: 'copper_ore' }],
        },
      ],
      state,
    });
  });

  it('does not reserve the same bank stock for simultaneous equipment Goals', () => {
    const stanGoal = buildEquipmentGoal();
    const kyleGoal: ActiveGoal & EquipItemGoal = {
      characterName: 'Kyle',
      id: 'equip-kyle-sword',
      itemCode: 'copper_sword',
      origin: 'configured',
      type: 'equipItem',
    };
    const dagger = {
      ...buildItem(),
      craft: {
        items: [{ code: 'copper_bar', quantity: 2 }],
        level: 5,
        quantity: 1,
        skill: 'weaponcrafting' as const,
      },
    };
    const sword = { ...dagger, code: 'copper_sword' };
    const state = buildState([stanGoal, kyleGoal]);
    const planner = createGoalActivityPlanner(
      buildKnowledge({ items: [dagger, sword] }),
    );
    const snapshot = {
      ...buildSnapshot([{ code: 'copper_bar', quantity: 2 }]),
      characters: [buildCharacter('Stan'), buildCharacter('Kyle')],
    };

    const result = planner(snapshot, state);

    expect(result._unsafeUnwrap()).toEqual({
      activities: [
        {
          activity: {
            itemCode: 'copper_bar',
            quantity: 2,
            type: 'withdrawItem',
          },
          characterName: 'Stan',
          consumes: [{ itemCode: 'copper_bar', quantity: 2 }],
          goalId: 'equip-stan-dagger',
          produces: [],
        },
      ],
      state,
    });
  });

  it('replenishes stock reserved by a higher-priority equipment Goal', () => {
    const equipmentGoal = buildEquipmentGoal();
    const replenishGoal = {
      ...buildGoal('replenish-bars', 'copper_bar'),
      minimumBankQuantity: 2,
    };
    const item = {
      ...buildItem(),
      craft: {
        items: [{ code: 'copper_bar', quantity: 2 }],
        level: 5,
        quantity: 1,
        skill: 'weaponcrafting' as const,
      },
    };
    const barResource = buildResource('copper_rocks', 'copper_bar', 'mining');
    const state = buildState([equipmentGoal, replenishGoal]);
    const planner = createGoalActivityPlanner(
      buildKnowledge({ items: [item], resources: [barResource] }),
    );
    const snapshot = {
      ...buildSnapshot([{ code: 'copper_bar', quantity: 2 }]),
      characters: [buildCharacter('Stan'), buildCharacter('Kyle')],
    };

    const result = planner(snapshot, state);

    expect(result._unsafeUnwrap()).toEqual({
      activities: [
        {
          activity: {
            itemCode: 'copper_bar',
            quantity: 2,
            type: 'withdrawItem',
          },
          characterName: 'Stan',
          consumes: [{ itemCode: 'copper_bar', quantity: 2 }],
          goalId: 'equip-stan-dagger',
          produces: [],
        },
        {
          activity: { resourceCode: 'copper_rocks', type: 'farmResource' },
          characterName: 'Kyle',
          consumes: [],
          goalId: 'replenish-bars',
          produces: [{ itemCode: 'copper_bar' }],
        },
      ],
      state,
    });
  });

  it('preserves a satisfied bank Goal consumed by lower-priority work', () => {
    const equipmentGoal = buildEquipmentGoal();
    const replenishGoal = {
      ...buildGoal('replenish-bars', 'copper_bar'),
      minimumBankQuantity: 2,
    };
    const item = {
      ...buildItem(),
      craft: {
        items: [{ code: 'copper_bar', quantity: 2 }],
        level: 5,
        quantity: 1,
        skill: 'weaponcrafting' as const,
      },
    };
    const barResource = buildResource('copper_rocks', 'copper_bar', 'mining');
    const state = buildState([replenishGoal, equipmentGoal]);
    const planner = createGoalActivityPlanner(
      buildKnowledge({ items: [item], resources: [barResource] }),
    );
    const snapshot = {
      ...buildSnapshot([{ code: 'copper_bar', quantity: 2 }]),
      characters: [buildCharacter('Stan'), buildCharacter('Kyle')],
    };

    const result = planner(snapshot, state);

    expect(result._unsafeUnwrap()).toEqual({
      activities: [
        {
          activity: {
            itemCode: 'copper_bar',
            quantity: 2,
            type: 'withdrawItem',
          },
          characterName: 'Stan',
          consumes: [{ itemCode: 'copper_bar', quantity: 2 }],
          goalId: 'equip-stan-dagger',
          produces: [],
        },
      ],
      state,
    });
  });

  it('completes a material prerequisite before its parent consumes the stock', () => {
    const equipmentGoal = buildEquipmentGoal();
    const professionGoal: ActiveGoal & ReachProfessionLevelGoal = {
      ...buildProfessionGoal(),
      id: 'reachProfessionLevel:Stan:weaponcrafting:11',
      targetLevel: 11,
    };
    const replenishGoal: ActiveGoal & ReplenishBankItemGoal = {
      id: 'replenishBankItem:copper_bar:2',
      itemCode: 'copper_bar',
      minimumBankQuantity: 2,
      origin: 'prerequisite',
      parentGoalId: professionGoal.id,
      reason: 'Supply a profession XP recipe',
      resourceCode: 'copper_rocks',
      rule: 'professionProgression',
      type: 'replenishBankItem',
    };
    const trainingRecipe: Item = {
      ...({} as Item),
      code: 'training_blade',
      craft: {
        items: [{ code: 'copper_bar', quantity: 2 }],
        level: 10,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    };
    const barResource = buildResource('copper_rocks', 'copper_bar', 'mining');
    const state = buildState([replenishGoal, professionGoal, equipmentGoal]);
    const planner = createGoalActivityPlanner(
      buildKnowledge({
        items: [buildItem(), trainingRecipe],
        resources: [barResource],
      }),
    );

    expect(
      planner(
        buildSnapshot([{ code: 'copper_bar', quantity: 2 }]),
        state,
      )._unsafeUnwrap(),
    ).toEqual({
      activities: [
        {
          activity: {
            itemCode: 'copper_bar',
            quantity: 2,
            type: 'withdrawItem',
          },
          characterName: 'Stan',
          consumes: [{ itemCode: 'copper_bar', quantity: 2 }],
          goalId: professionGoal.id,
          produces: [],
        },
      ],
      state: { goals: [professionGoal, equipmentGoal], reservations: [] },
    });
  });

  it('ignores unrelated bank items when evaluating a resource Goal', () => {
    const result = buildPlanner()(
      buildSnapshot([{ code: 'ash_wood', quantity: 50 }]),
      buildState([copperGoal]),
    );

    expect(result._unsafeUnwrap().activities).toEqual([
      {
        activity: { resourceCode: 'copper_rocks', type: 'farmResource' },
        characterName: 'Stan',
        consumes: [],
        goalId: 'goal-copper',
        produces: [{ itemCode: 'copper_ore' }],
      },
    ]);
  });

  it('does not count a withdrawal of another item against satisfied stock', () => {
    const equipmentGoal = buildEquipmentGoal();
    const item = {
      ...buildItem(),
      craft: {
        items: [{ code: 'ash_wood', quantity: 2 }],
        level: 5,
        quantity: 1,
        skill: 'weaponcrafting' as const,
      },
    };
    const state = buildState([equipmentGoal, copperGoal]);
    const planner = createGoalActivityPlanner(
      buildKnowledge({
        items: [item, buildRawItem('ash_wood')],
        resources: [copperResource],
      }),
    );

    const result = planner(
      buildSnapshot([
        { code: 'ash_wood', quantity: 2 },
        { code: 'copper_ore', quantity: 50 },
      ]),
      state,
    );

    expect(result._unsafeUnwrap().state.goals).toEqual([equipmentGoal]);
    expect(result._unsafeUnwrap().activities[0]?.activity).toEqual({
      itemCode: 'ash_wood',
      quantity: 2,
      type: 'withdrawItem',
    });
  });

  it('does not count a non-withdrawal Activity against satisfied stock', () => {
    const equipmentGoal: ActiveGoal & EquipItemGoal = {
      characterName: 'Stan',
      id: 'equip-stan-copper-ore',
      itemCode: 'copper_ore',
      origin: 'configured',
      type: 'equipItem',
    };
    const item = { ...buildItem(), code: 'copper_ore' };
    const state = buildState([equipmentGoal, copperGoal]);
    const planner = createGoalActivityPlanner(
      buildKnowledge({ items: [item], resources: [copperResource] }),
    );
    const snapshot = {
      ...buildSnapshot([{ code: 'copper_ore', quantity: 50 }]),
      characters: [
        {
          ...buildCharacter('Stan'),
          inventory: [{ code: 'copper_ore', quantity: 1, slot: 0 }],
        },
      ],
    };

    const result = planner(snapshot, state);

    expect(result._unsafeUnwrap().state.goals).toEqual([equipmentGoal]);
    expect(result._unsafeUnwrap().activities[0]?.activity).toEqual({
      itemCode: 'copper_ore',
      type: 'equipItem',
    });
  });

  it('uses a resolved material source for an equipment prerequisite', () => {
    const equipmentGoal = buildEquipmentGoal();
    const item = buildItem();
    item.craft = {
      items: [{ code: 'copper_bar', quantity: 2 }],
      level: 5,
      quantity: 1,
      skill: 'weaponcrafting',
    };
    const copperBar = {
      ...buildItem(),
      code: 'copper_bar',
      craft: {
        items: [{ code: 'copper_ore', quantity: 3 }],
        level: 1,
        quantity: 1,
        skill: 'weaponcrafting' as const,
      },
    };
    const copperOre = { ...({} as Item), code: 'copper_ore' };
    const planner = createGoalActivityPlanner(
      buildKnowledge({
        items: [item, copperBar, copperOre],
        resources: [copperResource],
      }),
    );
    const snapshot = {
      ...buildSnapshot(),
      characters: [buildCharacter('Stan'), buildCharacter('Cartman')],
    };

    const result = planner(snapshot, buildState([equipmentGoal]));

    expect(result._unsafeUnwrap().activities).toEqual([
      {
        activity: { resourceCode: 'copper_rocks', type: 'farmResource' },
        characterName: 'Cartman',
        consumes: [],
        goalId: 'equip-stan-dagger',
        produces: [{ itemCode: 'copper_ore' }],
      },
    ]);
  });

  it('resolves a unique monster source for a raw equipment material', () => {
    const equipmentGoal = buildEquipmentGoal();
    const item = {
      ...buildItem(),
      craft: {
        items: [{ code: 'yellow_slimeball', quantity: 1 }],
        level: 5,
        quantity: 1,
        skill: 'weaponcrafting' as const,
      },
    };
    const planner = createGoalActivityPlanner(
      buildKnowledge({
        items: [item, buildRawItem('yellow_slimeball')],
        monsters: [buildMonster('yellow_slimeball')],
      }),
    );
    const snapshot = {
      ...buildSnapshot(),
      characters: [buildCharacter('Stan'), buildCharacter('Cartman')],
    };

    const result = planner(snapshot, buildState([equipmentGoal]));

    expect(result._unsafeUnwrap().activities).toEqual([
      {
        activity: { monsterCode: 'yellow_slime', type: 'fightMonster' },
        characterName: 'Cartman',
        consumes: [],
        goalId: 'equip-stan-dagger',
        produces: [{ itemCode: 'yellow_slimeball' }],
      },
    ]);
  });

  it('does not choose an ambiguous source for an equipment material', () => {
    const item = buildItem();
    item.craft = {
      items: [{ code: 'copper_ore', quantity: 1 }],
      level: 5,
      quantity: 1,
      skill: 'weaponcrafting',
    };
    expect(item.craft?.items).toEqual([{ code: 'copper_ore', quantity: 1 }]);
    const copperOre = buildRawItem('copper_ore');
    const knowledge = buildKnowledge({
      items: [item, copperOre],
      monsters: [buildMonster('copper_ore')],
      resources: [copperResource],
    });

    expect(resolveEquipmentKnowledge(knowledge, item)).toEqual({
      items: [copperOre],
      sources: [],
    });
  });

  it('reports no knowledge when an equipment material is absent', () => {
    const item = buildItem();
    item.craft = {
      items: [{ code: 'unknown_material', quantity: 1 }],
      level: 5,
      quantity: 1,
      skill: 'weaponcrafting',
    };
    const knowledge = buildKnowledge({ items: [item] });

    expect(resolveEquipmentKnowledge(knowledge, item)).toEqual({
      items: [],
      sources: [],
    });
  });

  it('continues lower-priority work after an equipment Activity is blocked', () => {
    const equipmentGoal = buildEquipmentGoal();
    const state = buildState([equipmentGoal, copperGoal]);
    const planner = createGoalActivityPlanner(
      buildKnowledge({ items: [buildItem()], resources: [copperResource] }),
    );
    const snapshot = {
      ...buildSnapshot(),
      characters: [buildCharacter('Stan'), buildCharacter('Cartman')],
    };

    const result = planner(snapshot, state, {
      error: new Error('blocked'),
      event: { goalId: equipmentGoal.id, type: 'blocked' },
    });

    expect(result._unsafeUnwrap().activities).toEqual([
      {
        activity: { resourceCode: 'copper_rocks', type: 'farmResource' },
        characterName: 'Cartman',
        consumes: [],
        goalId: 'goal-copper',
        produces: [{ itemCode: 'copper_ore' }],
      },
    ]);
  });

  it('continues to lower-priority Goals while a higher-priority Goal is reserved', () => {
    const copperReservation = {
      activity: { resourceCode: 'copper_rocks', type: 'farmResource' as const },
      characterName: 'Stan',
      consumes: [],
      goalId: 'goal-copper',
      produces: [{ itemCode: 'copper_ore' }],
    };
    const state = {
      goals: [copperGoal, ashGoal],
      reservations: [copperReservation],
    };
    const snapshot = {
      ...buildSnapshot(),
      characters: [buildCharacter('Stan'), buildCharacter('Cartman')],
    };

    const result = buildPlanner()(snapshot, state);

    expect(result.isOk() && result.value).toEqual({
      activities: [
        {
          activity: { resourceCode: 'ash_tree', type: 'farmResource' },
          characterName: 'Cartman',
          consumes: [],
          goalId: 'goal-ash',
          produces: [{ itemCode: 'ash_wood' }],
        },
      ],
      state,
    });
  });

  it('removes every satisfied Goal without proposing work', () => {
    const result = buildPlanner()(
      buildSnapshot([
        { code: 'ash_wood', quantity: 50 },
        { code: 'copper_ore', quantity: 50 },
      ]),
      buildState(),
    );

    expect(result.isOk() && result.value).toEqual({
      activities: [],
      state: { goals: [], reservations: [] },
    });
  });

  it('does not skip an unsatisfied Goal when no Activity can start yet', () => {
    const reservation = {
      activity: { monsterCode: 'yellow_slime', type: 'fightMonster' as const },
      characterName: 'Stan',
      consumes: [],
      goalId: 'another-goal',
      produces: [],
    };
    const state = { goals: [copperGoal], reservations: [reservation] };
    const result = buildPlanner()(buildSnapshot(), state);

    expect(result.isOk() && result.value).toEqual({ activities: [], state });
  });

  it('propagates a resource validation failure', () => {
    const planner = createGoalActivityPlanner(
      buildKnowledge({ resources: [ashResource] }),
    );
    const invalidGoal = { ...copperGoal, resourceCode: ashResource.code };

    const result = planner(buildSnapshot(), buildState([invalidGoal]));

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(
      new InvalidResourceTargetError('ash_tree does not drop copper_ore'),
    );
  });

  it('returns a typed error when an equipment Goal has no resolved item', () => {
    const equipmentGoal = buildEquipmentGoal();
    const planner = createGoalActivityPlanner(buildKnowledge());

    const result = planner(buildSnapshot(), buildState([equipmentGoal]));

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      goalId: 'equip-stan-dagger',
      message: 'No item was resolved for Goal "equip-stan-dagger"',
      name: 'GoalItemNotResolvedError',
    });
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(GoalItemNotResolvedError);
  });

  it('uses a preferred resource when several resources produce the item', () => {
    const richCopperResource = buildResource(
      'rich_copper_rocks',
      'copper_ore',
      'mining',
    );
    const goal = { ...copperGoal, resourceCode: richCopperResource.code };
    const planner = createGoalActivityPlanner(
      buildKnowledge({ resources: [copperResource, richCopperResource] }),
    );

    const result = planner(buildSnapshot(), buildState([goal]));

    expect(result._unsafeUnwrap().activities[0]?.activity).toEqual({
      resourceCode: 'rich_copper_rocks',
      type: 'farmResource',
    });
  });

  it.each([
    ['no resource exists', []],
    [
      'several resources produce the item without a preferred source',
      [
        copperResource,
        buildResource('rich_copper_rocks', 'copper_ore', 'mining'),
      ],
    ],
  ])('returns a typed error when %s', (_reason, resources) => {
    const planner = createGoalActivityPlanner(buildKnowledge({ resources }));

    const result = planner(buildSnapshot(), buildState([copperGoal]));

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(GoalResourceNotResolvedError);
    expect(error).toMatchObject({
      goalId: 'goal-copper',
      message: 'No resource was resolved for Goal "goal-copper"',
      name: 'GoalResourceNotResolvedError',
    });
  });

  it('returns an unchanged empty plan when no Goals remain', () => {
    const state = buildState([]);

    expect(buildPlanner()(buildSnapshot(), state)._unsafeUnwrap()).toEqual({
      activities: [],
      state,
    });
  });
});
