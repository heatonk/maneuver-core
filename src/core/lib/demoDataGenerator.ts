/**
 * demoDataGenerator — type stubs for the per-game demo data generator hook.
 *
 * The full demo data orchestration that lives in Maneuver-2026 has not been
 * ported into maneuver-core yet (it pulls in a wider tba/event/validation
 * dep web). For now this file only declares the two types the per-game demo
 * generator (e.g. `src/game-template/demoDataGenerator2026.ts`) imports so
 * the rest of the codebase type-checks. Wire the runtime in when the demo
 * data feature is needed.
 */

import type { ScoutingEntryBase } from '@/core/types/scouting-entry';
import type { PitScoutingEntryBase } from '@/core/types/pit-scouting';

export interface GameDataGenerationContext {
    teamNumber: number;
    matchKey: string;
    matchNumber: number;
    eventKey: string;
    alliance: 'red' | 'blue';
    startPosition: number;
    skillLevel: 'elite' | 'strong' | 'average' | 'developing';
}

export interface GameDataGenerator {
    generateMatchEntry(context: GameDataGenerationContext): ScoutingEntryBase;
    generatePitEntry?(teamNumber: number): PitScoutingEntryBase;
}
