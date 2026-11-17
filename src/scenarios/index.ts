import type { Scenario, ScenarioId } from '../types';
import { plaza } from './plaza';
import { corridor } from './corridor';
import { bottleneck } from './bottleneck';
import { crossing } from './crossing';
import { shibuya } from './shibuya';

export const scenarios: Record<ScenarioId, Scenario> = { shibuya, plaza, corridor, bottleneck, crossing };
export function getScenario(id: ScenarioId): Scenario { return scenarios[id] ?? plaza; }
