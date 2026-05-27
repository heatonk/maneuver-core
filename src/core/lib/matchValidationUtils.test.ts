import { describe, expect, it } from 'vitest';
import {
    parseMatchKey,
    formatMatchLabel,
    normalizeMatchKey,
    extractTeamNumbers,
    getNestedValue,
    aggregateScoutingData,
    parseTBABreakdown,
    compareAllianceData,
    sortMatchList,
    filterAndSortMatches,
} from './matchValidationUtils';
import type {
    MatchListItem,
    ValidationConfig,
} from './matchValidationTypes';
import { DEFAULT_VALIDATION_CONFIG } from './matchValidationTypes';

// ============================================================================
// Test fixtures
// ============================================================================

function makeMatchListItem(overrides: Partial<MatchListItem> = {}): MatchListItem {
    return {
        matchKey: '2026test_qm1',
        matchNumber: 1,
        compLevel: 'qm',
        setNumber: 1,
        displayName: 'Qual 1',
        redTeams: ['111', '222', '333'],
        blueTeams: ['444', '555', '666'],
        hasScouting: false,
        scoutingComplete: false,
        redTeamsScouted: 0,
        blueTeamsScouted: 0,
        hasTBAResults: false,
        ...overrides,
    };
}

function makeScoutingEntry(
    teamNumber: number,
    gameData: Record<string, unknown>,
    scoutName = 'tester'
) {
    return { teamNumber, scoutName, gameData };
}

// gameData shape produced by src/game-template/transformation.ts
function makeGameData(opts: {
    autoFuel?: number;
    teleopFuel?: number;
    leftStartZone?: boolean;
    autoClimbLevel?: 1 | 2 | 3 | null;
    endgameClimbLevel?: 1 | 2 | 3 | null;
} = {}): Record<string, unknown> {
    return {
        auto: {
            fuelScoredCount: opts.autoFuel ?? 0,
            leftStartZone: opts.leftStartZone ?? false,
            autoClimbL1: opts.autoClimbLevel === 1,
            autoClimbL2: opts.autoClimbLevel === 2,
            autoClimbL3: opts.autoClimbLevel === 3,
        },
        teleop: {
            fuelScoredCount: opts.teleopFuel ?? 0,
        },
        endgame: {
            climbL1: opts.endgameClimbLevel === 1,
            climbL2: opts.endgameClimbLevel === 2,
            climbL3: opts.endgameClimbLevel === 3,
        },
    };
}

// ============================================================================
// parseMatchKey / formatMatchLabel
// ============================================================================

describe('parseMatchKey', () => {
    it('parses qualification match keys', () => {
        const parsed = parseMatchKey('2026test_qm15');
        expect(parsed.eventKey).toBe('2026test');
        expect(parsed.compLevel).toBe('qm');
        expect(parsed.matchNumber).toBe(15);
        expect(parsed.setNumber).toBe(1);
        expect(parsed.displayNumber).toBe('15');
    });

    it('parses semifinal match keys with set and match number', () => {
        const parsed = parseMatchKey('2026test_sf2m1');
        expect(parsed.compLevel).toBe('sf');
        expect(parsed.setNumber).toBe(2);
        expect(parsed.matchNumber).toBe(1);
        expect(parsed.displayNumber).toBe('2-1');
    });

    it('parses final match keys', () => {
        const parsed = parseMatchKey('2026test_f1m3');
        expect(parsed.compLevel).toBe('f');
        expect(parsed.setNumber).toBe(1);
        expect(parsed.matchNumber).toBe(3);
        expect(parsed.displayNumber).toBe('3');
    });

    it('throws on missing underscore', () => {
        expect(() => parseMatchKey('qm15')).toThrow();
    });
});

describe('formatMatchLabel', () => {
    it('formats qual match', () => {
        expect(formatMatchLabel('2026test_qm15')).toBe('Qual 15');
    });
    it('formats semifinal match', () => {
        expect(formatMatchLabel('2026test_sf1m2')).toBe('SF 1-2');
    });
    it('formats final match', () => {
        expect(formatMatchLabel('2026test_f1m2')).toBe('Final 2');
    });
    it('returns the raw key for unparseable input', () => {
        expect(formatMatchLabel('not_a_real_key')).toBe('not_a_real_key');
    });
});

// ============================================================================
// normalizeMatchKey
// ============================================================================

describe('normalizeMatchKey', () => {
    it('strips event-key prefix from TBA match keys', () => {
        expect(normalizeMatchKey('2026test_qm15')).toBe('qm15');
        expect(normalizeMatchKey('2026test_sf1m2')).toBe('sf1m2');
    });

    it('passes through bare match keys unchanged', () => {
        expect(normalizeMatchKey('qm15')).toBe('qm15');
        expect(normalizeMatchKey('sf1m2')).toBe('sf1m2');
    });

    it('returns empty string for a stray trailing underscore', () => {
        expect(normalizeMatchKey('2026test_')).toBe('');
    });
});

// ============================================================================
// extractTeamNumbers
// ============================================================================

describe('extractTeamNumbers', () => {
    it('strips frc prefix', () => {
        expect(extractTeamNumbers(['frc111', 'frc222', 'frc333'])).toEqual(['111', '222', '333']);
    });
    it('handles already-bare numbers', () => {
        expect(extractTeamNumbers(['111', '222'])).toEqual(['111', '222']);
    });
});

// ============================================================================
// getNestedValue
// ============================================================================

describe('getNestedValue', () => {
    it('resolves dotted paths', () => {
        const obj = { a: { b: { c: 42 } } };
        expect(getNestedValue(obj, 'a.b.c')).toBe(42);
    });

    it('returns undefined for missing intermediate keys', () => {
        const obj = { a: {} };
        expect(getNestedValue(obj as Record<string, unknown>, 'a.b.c')).toBeUndefined();
    });

    it('returns the value at a shallow key', () => {
        expect(getNestedValue({ foo: 'bar' }, 'foo')).toBe('bar');
    });
});

// ============================================================================
// aggregateScoutingData — covers the bug fixed on the fix-validation branch
// ============================================================================

describe('aggregateScoutingData', () => {
    it('sums auto fuel across teams by walking scoutedPath', () => {
        const match = makeMatchListItem();
        const entries = [
            makeScoutingEntry(111, makeGameData({ autoFuel: 2 })),
            makeScoutingEntry(222, makeGameData({ autoFuel: 3 })),
            makeScoutingEntry(333, makeGameData({ autoFuel: 5 })),
        ];

        const data = aggregateScoutingData('red', match, entries);

        expect(data.actions.autoFuelScored).toBe(10);
    });

    it('keeps auto and teleop fuel separate (regression: flatten was clobbering)', () => {
        const match = makeMatchListItem();
        const entries = [
            makeScoutingEntry(111, makeGameData({ autoFuel: 2, teleopFuel: 7 })),
            makeScoutingEntry(222, makeGameData({ autoFuel: 3, teleopFuel: 11 })),
        ];

        const data = aggregateScoutingData('red', match, entries);

        expect(data.actions.autoFuelScored).toBe(5);
        expect(data.actions.teleopFuelScored).toBe(18);
    });

    it('sums totalFuelScored across auto and teleop scoutedPaths', () => {
        const match = makeMatchListItem();
        const entries = [
            makeScoutingEntry(111, makeGameData({ autoFuel: 2, teleopFuel: 7 })),
            makeScoutingEntry(222, makeGameData({ autoFuel: 3, teleopFuel: 11 })),
        ];

        const data = aggregateScoutingData('red', match, entries);

        expect(data.actions.totalFuelScored).toBe(2 + 7 + 3 + 11);
    });

    it('counts each team once if ANY scoutedPath is truthy (autoClimbSuccess)', () => {
        const match = makeMatchListItem();
        const entries = [
            makeScoutingEntry(111, makeGameData({ autoClimbLevel: 1 })),
            makeScoutingEntry(222, makeGameData({ autoClimbLevel: 3 })),
            makeScoutingEntry(333, makeGameData({ autoClimbLevel: null })),
        ];

        const data = aggregateScoutingData('red', match, entries);

        expect(data.toggles.autoClimbSuccess).toBe(2);
    });

    it('counts a team once even when multiple paths are truthy', () => {
        const match = makeMatchListItem();
        // Defensive: shouldn't happen in practice, but mutually-exclusive
        // climb levels should still produce one count per entry.
        const entries = [
            makeScoutingEntry(111, {
                auto: { autoClimbL1: true, autoClimbL2: true, autoClimbL3: false },
                teleop: {},
                endgame: {},
            }),
        ];

        const data = aggregateScoutingData('red', match, entries);

        expect(data.toggles.autoClimbSuccess).toBe(1);
    });

    it('counts leftStartZone toggles per team', () => {
        const match = makeMatchListItem();
        const entries = [
            makeScoutingEntry(111, makeGameData({ leftStartZone: true })),
            makeScoutingEntry(222, makeGameData({ leftStartZone: false })),
            makeScoutingEntry(333, makeGameData({ leftStartZone: true })),
        ];

        const data = aggregateScoutingData('red', match, entries);

        expect(data.toggles.leftStartZone).toBe(2);
    });

    it('counts endgame climb levels separately', () => {
        const match = makeMatchListItem();
        const entries = [
            makeScoutingEntry(111, makeGameData({ endgameClimbLevel: 1 })),
            makeScoutingEntry(222, makeGameData({ endgameClimbLevel: 3 })),
            makeScoutingEntry(333, makeGameData({ endgameClimbLevel: 3 })),
        ];

        const data = aggregateScoutingData('red', match, entries);

        expect(data.toggles.climbL1).toBe(1);
        expect(data.toggles.climbL2).toBe(0);
        expect(data.toggles.climbL3).toBe(2);
    });

    it('records teams scouted from the entries, not from match.redTeams', () => {
        const match = makeMatchListItem();
        const entries = [
            makeScoutingEntry(111, makeGameData()),
            makeScoutingEntry(222, makeGameData()),
        ];

        const data = aggregateScoutingData('red', match, entries);

        expect(data.teams).toEqual(['111', '222']);
        expect(data.scoutedTeamsCount).toBe(2);
    });

    it('reports missing red teams when only some are scouted', () => {
        const match = makeMatchListItem();
        const entries = [
            makeScoutingEntry(111, makeGameData()),
            makeScoutingEntry(222, makeGameData()),
        ];

        const data = aggregateScoutingData('red', match, entries);

        expect(data.missingTeams).toEqual(['333']);
    });

    it('reports missing blue teams for a blue-alliance aggregation', () => {
        const match = makeMatchListItem();
        const entries = [makeScoutingEntry(444, makeGameData())];

        const data = aggregateScoutingData('blue', match, entries);

        expect(data.missingTeams).toEqual(['555', '666']);
    });

    it('initializes every mapping key to zero even when no entries match', () => {
        const match = makeMatchListItem();

        const data = aggregateScoutingData('red', match, []);

        expect(data.actions.autoFuelScored).toBe(0);
        expect(data.actions.teleopFuelScored).toBe(0);
        expect(data.actions.totalFuelScored).toBe(0);
        expect(data.toggles.climbL1).toBe(0);
        expect(data.toggles.autoClimbSuccess).toBe(0);
    });
});

// ============================================================================
// parseTBABreakdown
// ============================================================================

describe('parseTBABreakdown', () => {
    it('returns an empty breakdown when TBA score_breakdown is null', () => {
        // Consumers treat a missing key as 0 (`tba.breakdown[k] ?? 0`), so the
        // contract is just "do not throw, return a valid shell with score".
        const result = parseTBABreakdown('red', ['111', '222'], null, { score: 0 });
        expect(result.totalPoints).toBe(0);
        expect(result.breakdown).toEqual({});
        expect(result.teams).toEqual(['111', '222']);
    });

    it('extracts hubScore.* fields for fuel actions', () => {
        const breakdown = {
            autoPoints: 20,
            teleopPoints: 50,
            foulPoints: 5,
            foulCount: 1,
            techFoulCount: 0,
            hubScore: { autoCount: 8, teleopCount: 22, totalCount: 30 },
        };
        const result = parseTBABreakdown('red', ['111'], breakdown, { score: 75 });

        expect(result.totalPoints).toBe(75);
        expect(result.autoPoints).toBe(20);
        expect(result.teleopPoints).toBe(50);
        expect(result.foulPoints).toBe(5);
        expect(result.breakdown.autoFuelScored).toBe(8);
        expect(result.breakdown.teleopFuelScored).toBe(22);
        expect(result.breakdown.totalFuelScored).toBe(30);
    });

    it('counts endgame climb levels from per-robot slot fields', () => {
        const breakdown = {
            endGameTowerRobot1: 'Level1',
            endGameTowerRobot2: 'Level3',
            endGameTowerRobot3: 'None',
            autoTowerRobot1: 'None',
            autoTowerRobot2: 'None',
            autoTowerRobot3: 'None',
            autoLineRobot1: 'No',
            autoLineRobot2: 'No',
            autoLineRobot3: 'No',
        };
        const result = parseTBABreakdown('red', ['111'], breakdown, { score: 0 });

        expect(result.breakdown.climbL1).toBe(1);
        expect(result.breakdown.climbL2).toBe(0);
        expect(result.breakdown.climbL3).toBe(1);
    });

    it('counts leftStartZone slots that report "Yes"', () => {
        const breakdown = {
            autoLineRobot1: 'Yes',
            autoLineRobot2: 'Yes',
            autoLineRobot3: 'No',
            endGameTowerRobot1: 'None',
            endGameTowerRobot2: 'None',
            endGameTowerRobot3: 'None',
            autoTowerRobot1: 'None',
            autoTowerRobot2: 'None',
            autoTowerRobot3: 'None',
        };
        const result = parseTBABreakdown('red', ['111'], breakdown, { score: 0 });

        expect(result.breakdown.leftStartZone).toBe(2);
    });
});

// ============================================================================
// compareAllianceData
// ============================================================================

describe('compareAllianceData', () => {
    const config: ValidationConfig = DEFAULT_VALIDATION_CONFIG;

    it('produces no discrepancies when scouted matches TBA exactly', () => {
        const match = makeMatchListItem();
        const entries = [makeScoutingEntry(111, makeGameData({ autoFuel: 8, teleopFuel: 22 }))];
        const scouted = aggregateScoutingData('red', match, entries);
        const tba = parseTBABreakdown(
            'red',
            ['111'],
            {
                hubScore: { autoCount: 8, teleopCount: 22, totalCount: 30 },
                endGameTowerRobot1: 'None',
                endGameTowerRobot2: 'None',
                endGameTowerRobot3: 'None',
                autoTowerRobot1: 'None',
                autoTowerRobot2: 'None',
                autoTowerRobot3: 'None',
                autoLineRobot1: 'No',
                autoLineRobot2: 'No',
                autoLineRobot3: 'No',
            },
            { score: 30 }
        );

        const discrepancies = compareAllianceData(scouted, tba, config);

        expect(discrepancies).toHaveLength(0);
    });

    it('flags a large gap between scouted and TBA as critical', () => {
        const match = makeMatchListItem();
        const entries = [makeScoutingEntry(111, makeGameData({ autoFuel: 0 }))];
        const scouted = aggregateScoutingData('red', match, entries);
        const tba = parseTBABreakdown(
            'red',
            ['111'],
            { hubScore: { autoCount: 20, teleopCount: 0, totalCount: 20 } },
            { score: 40 }
        );

        const discrepancies = compareAllianceData(scouted, tba, config);

        const autoFuelDisc = discrepancies.find(d => d.field === 'autoFuelScored');
        expect(autoFuelDisc).toBeDefined();
        expect(autoFuelDisc?.severity).toBe('critical');
        expect(autoFuelDisc?.scoutedValue).toBe(0);
        expect(autoFuelDisc?.tbaValue).toBe(20);
    });

    it('classifies one-off counter slips as minor, not critical', () => {
        const match = makeMatchListItem();
        const entries = [makeScoutingEntry(111, makeGameData({ teleopFuel: 21 }))];
        const scouted = aggregateScoutingData('red', match, entries);
        const tba = parseTBABreakdown(
            'red',
            ['111'],
            { hubScore: { autoCount: 0, teleopCount: 22, totalCount: 22 } },
            { score: 22 }
        );

        const discrepancies = compareAllianceData(scouted, tba, config);
        const teleopDisc = discrepancies.find(d => d.field === 'teleopFuelScored');

        expect(teleopDisc).toBeDefined();
        expect(teleopDisc?.severity).toBe('minor');
        expect(teleopDisc?.difference).toBe(1);
    });
});

// ============================================================================
// sortMatchList / filterAndSortMatches
// ============================================================================

describe('sortMatchList', () => {
    it('orders qm < sf < f, then by set then by match number', () => {
        const matches = [
            makeMatchListItem({ matchKey: '2026test_f1m1', compLevel: 'f', matchNumber: 1 }),
            makeMatchListItem({ matchKey: '2026test_qm10', compLevel: 'qm', matchNumber: 10 }),
            makeMatchListItem({ matchKey: '2026test_qm2', compLevel: 'qm', matchNumber: 2 }),
            makeMatchListItem({ matchKey: '2026test_sf2m1', compLevel: 'sf', matchNumber: 1, setNumber: 2 }),
            makeMatchListItem({ matchKey: '2026test_sf1m1', compLevel: 'sf', matchNumber: 1, setNumber: 1 }),
        ];

        const sorted = sortMatchList(matches);

        expect(sorted.map(m => m.matchKey)).toEqual([
            '2026test_qm2',
            '2026test_qm10',
            '2026test_sf1m1',
            '2026test_sf2m1',
            '2026test_f1m1',
        ]);
    });
});

describe('filterAndSortMatches', () => {
    const baseMatches = [
        makeMatchListItem({ matchKey: '2026test_qm1', matchNumber: 1, hasScouting: true, scoutingComplete: true }),
        makeMatchListItem({ matchKey: '2026test_qm2', matchNumber: 2, hasScouting: false }),
        makeMatchListItem({ matchKey: '2026test_sf1m1', matchNumber: 1, compLevel: 'sf', hasScouting: true, scoutingComplete: false, redTeamsScouted: 2 }),
    ];

    it('filters by scoutingStatus=none', () => {
        const filtered = filterAndSortMatches(baseMatches, {
            status: 'all',
            matchType: 'all',
            scoutingStatus: 'none',
            searchQuery: '',
            sortBy: 'match',
            sortOrder: 'asc',
        });
        expect(filtered).toHaveLength(1);
        expect(filtered[0]?.matchKey).toBe('2026test_qm2');
    });

    it('filters by matchType=qm', () => {
        const filtered = filterAndSortMatches(baseMatches, {
            status: 'all',
            matchType: 'qm',
            scoutingStatus: 'all',
            searchQuery: '',
            sortBy: 'match',
            sortOrder: 'asc',
        });
        expect(filtered.map(m => m.compLevel)).toEqual(['qm', 'qm']);
    });

    it('searches by team number', () => {
        const matches = [
            makeMatchListItem({ matchKey: '2026test_qm1', redTeams: ['111', '222', '333'] }),
            makeMatchListItem({ matchKey: '2026test_qm2', redTeams: ['444', '555', '666'] }),
        ];

        const filtered = filterAndSortMatches(matches, {
            status: 'all',
            matchType: 'all',
            scoutingStatus: 'all',
            searchQuery: '222',
            sortBy: 'match',
            sortOrder: 'asc',
        });

        expect(filtered).toHaveLength(1);
        expect(filtered[0]?.matchKey).toBe('2026test_qm1');
    });
});
