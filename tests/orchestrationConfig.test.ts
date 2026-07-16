import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildInitialOrchestratorState,
  loadOrchestrationConfig,
  parseOrchestrationConfig,
} from '../src/utils/orchestrationConfig.js';

const buildRawConfig = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    goals: [
      {
        id: 'replenish-copper',
        itemCode: 'copper_ore',
        minimumBankQuantity: 50,
        resourceCode: 'copper_rocks',
        type: 'replenishBankItem',
      },
      {
        id: 'replenish-ash',
        itemCode: 'ash_wood',
        minimumBankQuantity: 25,
        resourceCode: 'ash_tree',
        type: 'replenishBankItem',
      },
    ],
    ...overrides,
  });

describe('parseOrchestrationConfig', () => {
  it('preserves explicit Goal priority and resource mappings', () => {
    const result = parseOrchestrationConfig(buildRawConfig());

    expect(result).toEqual({
      goals: [
        {
          id: 'replenish-copper',
          itemCode: 'copper_ore',
          minimumBankQuantity: 50,
          resourceCode: 'copper_rocks',
          type: 'replenishBankItem',
        },
        {
          id: 'replenish-ash',
          itemCode: 'ash_wood',
          minimumBankQuantity: 25,
          resourceCode: 'ash_tree',
          type: 'replenishBankItem',
        },
      ],
    });
  });

  it('accepts an explicit character equipment Goal', () => {
    expect(
      parseOrchestrationConfig(
        buildRawConfig({
          goals: [
            {
              characterName: 'Stan',
              id: 'equip-stan-dagger',
              itemCode: 'copper_dagger',
              type: 'equipItem',
            },
          ],
        }),
      ),
    ).toEqual({
      goals: [
        {
          characterName: 'Stan',
          id: 'equip-stan-dagger',
          itemCode: 'copper_dagger',
          type: 'equipItem',
        },
      ],
    });
  });

  it.each([0, -1, 1.5])(
    'rejects invalid bank quantity %s',
    (minimumBankQuantity) => {
      expect(() =>
        parseOrchestrationConfig(
          buildRawConfig({
            goals: [
              {
                id: 'replenish-copper',
                itemCode: 'copper_ore',
                minimumBankQuantity,
                resourceCode: 'copper_rocks',
                type: 'replenishBankItem',
              },
            ],
          }),
        ),
      ).toThrow(/Invalid orchestration configuration/);
    },
  );

  it.each(['id', 'itemCode', 'resourceCode'])(
    'rejects an empty %s',
    (field) => {
      expect(() =>
        parseOrchestrationConfig(
          buildRawConfig({
            goals: [
              {
                id: 'replenish-copper',
                itemCode: 'copper_ore',
                minimumBankQuantity: 50,
                resourceCode: 'copper_rocks',
                type: 'replenishBankItem',
                [field]: '',
              },
            ],
          }),
        ),
      ).toThrow(/Invalid orchestration configuration/);
    },
  );

  it('reports field paths and separates multiple validation issues', () => {
    let message = '';

    try {
      parseOrchestrationConfig(
        buildRawConfig({
          goals: [
            {
              id: '',
              itemCode: '',
              minimumBankQuantity: 50,
              resourceCode: 'copper_rocks',
              type: 'replenishBankItem',
            },
          ],
        }),
      );
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('goals.0.id');
    expect(message).toContain('goals.0.itemCode');
    expect(message.split('\n')).toHaveLength(3);
  });

  it('reports a root path when the whole configuration has the wrong shape', () => {
    expect(() => parseOrchestrationConfig(JSON.stringify(null))).toThrow(
      /\(root\)/,
    );
  });

  it('rejects duplicate Goal ids', () => {
    expect(() =>
      parseOrchestrationConfig(
        buildRawConfig({
          goals: [
            {
              id: 'duplicate',
              itemCode: 'copper_ore',
              minimumBankQuantity: 50,
              resourceCode: 'copper_rocks',
              type: 'replenishBankItem',
            },
            {
              id: 'duplicate',
              itemCode: 'ash_wood',
              minimumBankQuantity: 25,
              resourceCode: 'ash_tree',
              type: 'replenishBankItem',
            },
          ],
        }),
      ),
    ).toThrow(/Goal ids must be unique/);
  });

  it('rejects unknown Goal fields instead of silently ignoring typos', () => {
    expect(() =>
      parseOrchestrationConfig(
        buildRawConfig({
          goals: [
            {
              id: 'replenish-copper',
              itemCode: 'copper_ore',
              minimumBankQuantity: 50,
              resource: 'copper_rocks',
              resourceCode: 'copper_rocks',
              type: 'replenishBankItem',
            },
          ],
        }),
      ),
    ).toThrow(/Invalid orchestration configuration/);
  });

  it('rejects an unknown Goal type', () => {
    expect(() =>
      parseOrchestrationConfig(
        buildRawConfig({
          goals: [
            {
              id: 'replenish-copper',
              itemCode: 'copper_ore',
              minimumBankQuantity: 50,
              resourceCode: 'copper_rocks',
              type: 'unknown',
            },
          ],
        }),
      ),
    ).toThrow(/Invalid orchestration configuration/);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseOrchestrationConfig('{not json')).toThrow();
  });

  it('accepts an empty Goal list', () => {
    expect(parseOrchestrationConfig(JSON.stringify({ goals: [] }))).toEqual({
      goals: [],
    });
  });
});

describe('loadOrchestrationConfig', () => {
  it('reads and validates an explicit configuration path', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'artifactsmmo-orchestration-'),
    );
    const path = join(directory, 'crew.json');
    writeFileSync(path, buildRawConfig(), 'utf-8');

    try {
      expect(loadOrchestrationConfig(path)).toEqual(
        parseOrchestrationConfig(buildRawConfig()),
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

describe('buildInitialOrchestratorState', () => {
  it('preserves equipment Goal ownership', () => {
    const config = parseOrchestrationConfig(
      buildRawConfig({
        goals: [
          {
            characterName: 'Stan',
            id: 'equip-stan-dagger',
            itemCode: 'copper_dagger',
            type: 'equipItem',
          },
        ],
      }),
    );

    expect(buildInitialOrchestratorState(config)).toEqual({
      goals: [
        {
          characterName: 'Stan',
          id: 'equip-stan-dagger',
          itemCode: 'copper_dagger',
          type: 'equipItem',
        },
      ],
      reservations: [],
    });
  });

  it('removes Adapter-only resource codes from the domain state', () => {
    const config = parseOrchestrationConfig(buildRawConfig());

    expect(buildInitialOrchestratorState(config)).toEqual({
      goals: [
        {
          id: 'replenish-copper',
          itemCode: 'copper_ore',
          minimumBankQuantity: 50,
          type: 'replenishBankItem',
        },
        {
          id: 'replenish-ash',
          itemCode: 'ash_wood',
          minimumBankQuantity: 25,
          type: 'replenishBankItem',
        },
      ],
      reservations: [],
    });
  });
});
