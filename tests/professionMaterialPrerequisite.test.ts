import { describe, expect, it } from 'vitest';

import type { CrewSnapshot } from '../src/bot/orchestration/crewSnapshot.js';
import type {
  ActiveGoal,
  OrchestratorState,
} from '../src/bot/orchestration/orchestratorState.js';
import {
  createProduceItemGoalId,
  createReplenishBankItemGoalId,
  proposeProfessionMaterialPrerequisite,
} from '../src/bot/orchestration/professionMaterialPrerequisite.js';
import type { WorldKnowledge } from '../src/bot/orchestration/worldKnowledge.js';
import type { components } from '../src/client/schema.js';

type Character = components['schemas']['CharacterSchema'];
type Item = components['schemas']['ItemSchema'];
type Monster = components['schemas']['MonsterSchema'];
type Resource = components['schemas']['ResourceSchema'];

const buildCharacter = (overrides: Partial<Character> = {}): Character => ({
  ...({} as Character),
  inventory: [],
  mining_level: 1,
  name: 'Stan',
  weaponcrafting_level: 2,
  ...overrides,
});

const buildRecipe = (overrides: Partial<Item> = {}): Item => ({
  ...({} as Item),
  code: 'training_blade',
  craft: {
    items: [{ code: 'copper_ore', quantity: 2 }],
    level: 2,
    quantity: 1,
    skill: 'weaponcrafting',
  },
  ...overrides,
});

const buildRawItem = (overrides: Partial<Item> = {}): Item => ({
  ...({} as Item),
  code: 'copper_ore',
  ...overrides,
});

const buildResource = (overrides: Partial<Resource> = {}): Resource => ({
  code: 'copper_rocks',
  drops: [
    { code: 'stone', max_quantity: 1, min_quantity: 1, rate: 1 },
    { code: 'copper_ore', max_quantity: 1, min_quantity: 1, rate: 1 },
  ],
  level: 1,
  name: 'Copper Rocks',
  skill: 'mining',
  ...overrides,
});

const buildMonster = (): Monster => ({
  ...({} as Monster),
  code: 'copper_golem',
  drops: [
    { code: 'stone', max_quantity: 1, min_quantity: 1, rate: 1 },
    { code: 'copper_ore', max_quantity: 1, min_quantity: 1, rate: 1 },
  ],
});

const parentGoal: ActiveGoal = {
  characterName: 'Stan',
  id: 'equipItem:Stan:copper_dagger',
  itemCode: 'copper_dagger',
  origin: 'autonomous',
  reason: 'Improve combat equipment',
  rule: 'equipmentUpgrade',
  type: 'equipItem',
};

const professionGoal: ActiveGoal = {
  characterName: 'Stan',
  id: 'reachProfessionLevel:Stan:weaponcrafting:5',
  origin: 'prerequisite',
  parentGoalId: parentGoal.id,
  reason: 'Reach the crafting level required by the parent',
  rule: 'professionProgression',
  skill: 'weaponcrafting',
  targetLevel: 5,
  type: 'reachProfessionLevel',
};

const buildSnapshot = (
  character: Character = buildCharacter(),
  bank: CrewSnapshot['bank'] = [],
): CrewSnapshot => ({
  bank,
  capturedAt: '2026-07-17T12:00:00.000Z',
  characters: [character],
});

const buildState = (
  overrides: Partial<OrchestratorState> = {},
): OrchestratorState => ({
  goals: [professionGoal, parentGoal],
  reservations: [],
  ...overrides,
});

const buildKnowledge = (
  overrides: Partial<WorldKnowledge> = {},
): WorldKnowledge => ({
  items: [buildRawItem(), buildRecipe()],
  monsters: [],
  resources: [buildResource()],
  ...overrides,
});

describe('createReplenishBankItemGoalId', () => {
  it('creates a stable semantic id from the item and target quantity', () => {
    expect(createReplenishBankItemGoalId('copper_ore', 2)).toBe(
      'replenishBankItem:copper_ore:2',
    );
  });
});

describe('createProduceItemGoalId', () => {
  it('creates a stable semantic id from the item and target quantity', () => {
    expect(createProduceItemGoalId('copper_bar', 2)).toBe(
      'produceItem:copper_bar:2',
    );
  });
});

describe('proposeProfessionMaterialPrerequisite', () => {
  it('proposes one raw gathering prerequisite before the profession Goal', () => {
    expect(
      proposeProfessionMaterialPrerequisite(
        buildSnapshot(),
        buildState(),
        buildKnowledge(),
      ),
    ).toEqual([
      {
        configuredRank: -1,
        goal: {
          id: 'replenishBankItem:copper_ore:2',
          itemCode: 'copper_ore',
          minimumBankQuantity: 2,
          resourceCode: 'copper_rocks',
          type: 'replenishBankItem',
        },
        parentGoalId: professionGoal.id,
        reason:
          'Stan needs 2x copper_ore from copper_rocks to craft training_blade for weaponcrafting XP',
        rule: 'professionProgression',
      },
    ]);
  });

  it('proposes a monster-backed prerequisite for one unambiguous drop source', () => {
    expect(
      proposeProfessionMaterialPrerequisite(
        buildSnapshot(),
        buildState(),
        buildKnowledge({ monsters: [buildMonster()], resources: [] }),
      ),
    ).toEqual([
      {
        configuredRank: -1,
        goal: {
          id: 'replenishBankItem:copper_ore:2',
          itemCode: 'copper_ore',
          minimumBankQuantity: 2,
          monsterCode: 'copper_golem',
          type: 'replenishBankItem',
        },
        parentGoalId: professionGoal.id,
        reason:
          'Stan needs 2x copper_ore from copper_golem to craft training_blade for weaponcrafting XP',
        rule: 'professionProgression',
      },
    ]);
  });

  it('ignores unrelated monsters while resolving one monster drop source', () => {
    const unrelatedMonster = {
      ...buildMonster(),
      drops: [
        { code: 'unrelated_drop', max_quantity: 1, min_quantity: 1, rate: 1 },
      ],
    };
    const matchingMonster = {
      ...buildMonster(),
      code: 'slime_king',
      drops: [
        { code: 'copper_ore', max_quantity: 1, min_quantity: 1, rate: 1 },
      ],
    };

    expect(
      proposeProfessionMaterialPrerequisite(
        buildSnapshot(),
        buildState(),
        buildKnowledge({
          monsters: [unrelatedMonster, matchingMonster],
          resources: [],
        }),
      )[0]?.goal,
    ).toMatchObject({ monsterCode: 'slime_king' });
  });

  it('uses held and unreserved bank stock to size the prerequisite', () => {
    const character = buildCharacter({
      inventory: [{ code: 'copper_ore', quantity: 1, slot: 0 }],
    });
    const state = buildState({
      reservations: [
        {
          activity: {
            itemCode: 'copper_ore',
            quantity: 1,
            type: 'withdrawItem',
          },
          characterName: 'Kyle',
          consumes: [{ itemCode: 'copper_ore', quantity: 1 }],
          goalId: 'another-goal',
          produces: [],
        },
      ],
    });

    expect(
      proposeProfessionMaterialPrerequisite(
        buildSnapshot(character, [{ code: 'copper_ore', quantity: 1 }]),
        state,
        buildKnowledge(),
      )[0]?.goal,
    ).toMatchObject({ itemCode: 'copper_ore', minimumBankQuantity: 1 });
  });

  it('does not propose acquisition while an executable XP recipe exists', () => {
    expect(
      proposeProfessionMaterialPrerequisite(
        buildSnapshot(buildCharacter(), [{ code: 'copper_ore', quantity: 2 }]),
        buildState(),
        buildKnowledge(),
      ),
    ).toEqual([]);
  });

  it('prefers recipe level before the stable recipe code', () => {
    const lowRecipe = buildRecipe({
      code: 'a_low_recipe',
      craft: {
        items: [{ code: 'copper_ore', quantity: 2 }],
        level: 1,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const highRecipe = buildRecipe({
      code: 'z_high_recipe',
      craft: {
        items: [{ code: 'iron_ore', quantity: 1 }],
        level: 2,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const ironItem = buildRawItem({ code: 'iron_ore' });
    const ironResource = buildResource({
      code: 'iron_rocks',
      drops: [{ code: 'iron_ore', max_quantity: 1, min_quantity: 1, rate: 1 }],
    });

    const proposal = proposeProfessionMaterialPrerequisite(
      buildSnapshot(),
      buildState(),
      buildKnowledge({
        items: [buildRawItem(), ironItem, lowRecipe, highRecipe],
        resources: [buildResource(), ironResource],
      }),
    )[0];

    expect(proposal?.goal).toMatchObject({ itemCode: 'iron_ore' });
    expect(proposal?.reason).toContain('z_high_recipe');
  });

  it.each([
    {
      invalidRecipe: buildRecipe({
        code: 'a_wrong_skill',
        craft: {
          items: [{ code: 'iron_ore', quantity: 1 }],
          level: 2,
          quantity: 1,
          skill: 'gearcrafting',
        },
      }),
      name: 'another crafting skill',
    },
    {
      invalidRecipe: buildRecipe({
        code: 'a_future_recipe',
        craft: {
          items: [{ code: 'iron_ore', quantity: 1 }],
          level: 3,
          quantity: 1,
          skill: 'weaponcrafting',
        },
      }),
      name: 'a recipe above the current profession level',
    },
    {
      invalidRecipe: buildRecipe({
        code: 'a_empty_recipe',
        craft: { level: 2, quantity: 1, skill: 'weaponcrafting' },
      }),
      name: 'a recipe without materials',
    },
    {
      invalidRecipe: buildRecipe({
        code: 'a_zero_material_recipe',
        craft: { items: [], level: 2, quantity: 1, skill: 'weaponcrafting' },
      }),
      name: 'a recipe with an empty material list',
    },
  ])('ignores $name', ({ invalidRecipe }) => {
    const validRecipe = buildRecipe({ code: 'z_valid_recipe', level: 1 });
    const ironItem = buildRawItem({ code: 'iron_ore' });
    const ironResource = buildResource({
      code: 'iron_rocks',
      drops: [{ code: 'iron_ore', max_quantity: 1, min_quantity: 1, rate: 1 }],
    });

    expect(
      proposeProfessionMaterialPrerequisite(
        buildSnapshot(),
        buildState(),
        buildKnowledge({
          items: [buildRawItem(), ironItem, invalidRecipe, validRecipe],
          resources: [buildResource(), ironResource],
        }),
      )[0]?.goal,
    ).toMatchObject({ itemCode: 'copper_ore' });
  });

  it('skips materials already covered by duplicate bank rows', () => {
    const recipe = buildRecipe({
      craft: {
        items: [
          { code: 'ash_wood', quantity: 2 },
          { code: 'copper_ore', quantity: 2 },
        ],
        level: 2,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const ashItem = buildRawItem({ code: 'ash_wood' });
    const ashResource = buildResource({
      code: 'ash_tree',
      drops: [{ code: 'ash_wood', max_quantity: 1, min_quantity: 1, rate: 1 }],
      skill: 'woodcutting',
    });
    const character = buildCharacter({ woodcutting_level: 1 });

    expect(
      proposeProfessionMaterialPrerequisite(
        buildSnapshot(character, [
          { code: 'unrelated', quantity: 100 },
          { code: 'ash_wood', quantity: 1 },
          { code: 'ash_wood', quantity: 1 },
        ]),
        buildState(),
        buildKnowledge({
          items: [ashItem, buildRawItem(), recipe],
          resources: [ashResource, buildResource()],
        }),
      )[0]?.goal,
    ).toMatchObject({ itemCode: 'copper_ore' });
  });

  it('accounts for reserved bank stock while scanning recipe materials', () => {
    const recipe = buildRecipe({
      craft: {
        items: [
          { code: 'ash_wood', quantity: 1 },
          { code: 'copper_ore', quantity: 2 },
        ],
        level: 2,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const ashItem = buildRawItem({ code: 'ash_wood' });
    const ashResource = buildResource({
      code: 'ash_tree',
      drops: [{ code: 'ash_wood', max_quantity: 1, min_quantity: 1, rate: 1 }],
      skill: 'woodcutting',
    });
    const state = buildState({
      reservations: [
        {
          activity: { itemCode: 'ash_wood', quantity: 1, type: 'withdrawItem' },
          characterName: 'Kyle',
          consumes: [{ itemCode: 'ash_wood', quantity: 1 }],
          goalId: 'another-goal',
          produces: [],
        },
      ],
    });

    expect(
      proposeProfessionMaterialPrerequisite(
        buildSnapshot(buildCharacter({ woodcutting_level: 1 }), [
          { code: 'ash_wood', quantity: 1 },
        ]),
        state,
        buildKnowledge({
          items: [ashItem, buildRawItem(), recipe],
          resources: [ashResource, buildResource()],
        }),
      )[0]?.goal,
    ).toMatchObject({ itemCode: 'ash_wood' });
  });

  it('skips unknown materials and continues with a resolvable material', () => {
    const recipe = buildRecipe({
      craft: {
        items: [
          { code: 'unknown_dust', quantity: 1 },
          { code: 'copper_ore', quantity: 2 },
        ],
        level: 2,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });

    expect(
      proposeProfessionMaterialPrerequisite(
        buildSnapshot(),
        buildState(),
        buildKnowledge({ items: [buildRawItem(), recipe] }),
      )[0]?.goal,
    ).toMatchObject({ itemCode: 'copper_ore' });
  });

  it('proposes a craft prerequisite for a missing intermediate with satisfied materials', () => {
    const intermediate = buildRawItem({
      code: 'copper_bar',
      craft: {
        items: [{ code: 'copper_ore', quantity: 2 }],
        level: 1,
        quantity: 1,
        skill: 'mining',
      },
    });
    const recipe = buildRecipe({
      craft: {
        items: [{ code: 'copper_bar', quantity: 3 }],
        level: 2,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });

    expect(
      proposeProfessionMaterialPrerequisite(
        buildSnapshot(buildCharacter(), [{ code: 'copper_ore', quantity: 6 }]),
        buildState(),
        buildKnowledge({ items: [buildRawItem(), intermediate, recipe] }),
      ),
    ).toEqual([
      {
        configuredRank: -1,
        goal: {
          id: 'produceItem:copper_bar:3',
          itemCode: 'copper_bar',
          minimumBankQuantity: 3,
          type: 'produceItem',
        },
        parentGoalId: professionGoal.id,
        reason:
          'Stan needs 3x copper_bar crafted to craft training_blade for weaponcrafting XP',
        rule: 'professionProgression',
      },
    ]);
  });

  it('skips a satisfied material to reach a craftable intermediate further in the recipe', () => {
    const intermediate = buildRawItem({
      code: 'copper_bar',
      craft: {
        items: [{ code: 'copper_ore', quantity: 1 }],
        level: 1,
        quantity: 1,
        skill: 'mining',
      },
    });
    const recipe = buildRecipe({
      craft: {
        items: [
          { code: 'ash_wood', quantity: 1 },
          { code: 'copper_bar', quantity: 1 },
        ],
        level: 2,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const character = buildCharacter({
      inventory: [{ code: 'ash_wood', quantity: 1, slot: 0 }],
    });

    expect(
      proposeProfessionMaterialPrerequisite(
        buildSnapshot(character, [{ code: 'copper_ore', quantity: 1 }]),
        buildState(),
        buildKnowledge({ items: [buildRawItem(), intermediate, recipe] }),
      )[0]?.goal,
    ).toMatchObject({ itemCode: 'copper_bar', type: 'produceItem' });
  });

  it('does not treat a craft definition without materials as a resolvable intermediate', () => {
    const intermediate = buildRawItem({
      code: 'copper_bar',
      craft: { items: [], level: 1, quantity: 1, skill: 'mining' },
    });
    const recipe = buildRecipe({
      craft: {
        items: [{ code: 'copper_bar', quantity: 1 }],
        level: 2,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });

    expect(
      proposeProfessionMaterialPrerequisite(
        buildSnapshot(),
        buildState(),
        buildKnowledge({ items: [buildRawItem(), intermediate, recipe] }),
      ),
    ).toEqual([]);
  });

  it('requires every one of a craftable material own materials, not just one', () => {
    const intermediate = buildRawItem({
      code: 'copper_bar',
      craft: {
        items: [
          { code: 'copper_ore', quantity: 2 },
          { code: 'coal', quantity: 1 },
        ],
        level: 1,
        quantity: 1,
        skill: 'mining',
      },
    });
    const recipe = buildRecipe({
      craft: {
        items: [
          { code: 'copper_bar', quantity: 1 },
          { code: 'copper_ore', quantity: 2 },
        ],
        level: 2,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });

    expect(
      proposeProfessionMaterialPrerequisite(
        buildSnapshot(buildCharacter(), [{ code: 'copper_ore', quantity: 6 }]),
        buildState(),
        buildKnowledge({ items: [buildRawItem(), intermediate, recipe] }),
      ),
    ).toEqual([]);
  });

  it('falls through an unsatisfiable craftable material to the next recipe material', () => {
    const recipe = buildRecipe({
      craft: {
        items: [
          { code: 'copper_bar', quantity: 1 },
          { code: 'copper_ore', quantity: 2 },
        ],
        level: 2,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const intermediate = buildRawItem({
      code: 'copper_bar',
      craft: {
        items: [{ code: 'iron_ore', quantity: 2 }],
        level: 1,
        quantity: 1,
        skill: 'mining',
      },
    });

    expect(
      proposeProfessionMaterialPrerequisite(
        buildSnapshot(),
        buildState(),
        buildKnowledge({ items: [buildRawItem(), intermediate, recipe] }),
      )[0]?.goal,
    ).toMatchObject({ itemCode: 'copper_ore', type: 'replenishBankItem' });
  });

  it('does not acquire for a harder recipe while an easier recipe is executable', () => {
    const executableRecipe = buildRecipe({
      code: 'executable_recipe',
      craft: {
        items: [{ code: 'ash_wood', quantity: 1 }],
        level: 1,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const missingRecipe = buildRecipe({ code: 'missing_recipe' });

    expect(
      proposeProfessionMaterialPrerequisite(
        buildSnapshot(buildCharacter(), [{ code: 'ash_wood', quantity: 1 }]),
        buildState(),
        buildKnowledge({ items: [executableRecipe, missingRecipe] }),
      ),
    ).toEqual([]);
  });

  it.each([
    {
      name: 'the material is craftable',
      world: buildKnowledge({
        items: [
          buildRawItem({
            craft: {
              items: [{ code: 'copper_ore', quantity: 1 }],
              level: 1,
              quantity: 1,
              skill: 'mining',
            },
          }),
          buildRecipe(),
        ],
      }),
    },
    {
      name: 'the material source is ambiguous',
      world: buildKnowledge({ monsters: [buildMonster()] }),
    },
    {
      name: 'several resources drop the material',
      world: buildKnowledge({
        resources: [
          buildResource(),
          buildResource({ code: 'abandoned_copper_rocks' }),
        ],
      }),
    },
    {
      name: 'the gathering profession is too low',
      world: buildKnowledge({ resources: [buildResource({ level: 2 })] }),
    },
  ])('waits when $name', ({ world }) => {
    expect(
      proposeProfessionMaterialPrerequisite(
        buildSnapshot(),
        buildState(),
        world,
      ),
    ).toEqual([]);
  });

  it('uses the profession Goal character rather than the first crew member', () => {
    const snapshot = {
      ...buildSnapshot(),
      characters: [
        buildCharacter({ name: 'Kyle', weaponcrafting_level: 5 }),
        buildCharacter(),
      ],
    };

    expect(
      proposeProfessionMaterialPrerequisite(
        snapshot,
        buildState(),
        buildKnowledge(),
      ),
    ).toHaveLength(1);
  });

  it('ignores completed and absent profession Goals or characters', () => {
    expect(
      proposeProfessionMaterialPrerequisite(
        buildSnapshot(buildCharacter({ weaponcrafting_level: 5 })),
        buildState(),
        buildKnowledge(),
      ),
    ).toEqual([]);
    expect(
      proposeProfessionMaterialPrerequisite(
        buildSnapshot(),
        buildState({ goals: [parentGoal] }),
        buildKnowledge(),
      ),
    ).toEqual([]);
    expect(
      proposeProfessionMaterialPrerequisite(
        { ...buildSnapshot(), characters: [] },
        buildState(),
        buildKnowledge(),
      ),
    ).toEqual([]);
  });

  it.each([
    {
      characterName: 'Kyle',
      goalId: professionGoal.id,
      name: 'the Goal has work running on another character',
    },
    {
      characterName: 'Stan',
      goalId: 'another-goal',
      name: 'the profession character is busy with another Goal',
    },
  ])('waits when $name', ({ characterName, goalId }) => {
    const reservation = {
      activity: { monsterCode: 'chicken', type: 'fightMonster' as const },
      characterName,
      consumes: [],
      goalId,
      produces: [],
    };

    expect(
      proposeProfessionMaterialPrerequisite(
        buildSnapshot(),
        buildState({ reservations: [reservation] }),
        buildKnowledge(),
      ),
    ).toEqual([]);
  });
});
