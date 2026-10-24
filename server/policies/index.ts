import type { RoutingPolicy } from '../../shared/policy-types';
import { DEMO_POLICY } from './demo-policy-1.0';

/** Registry of all policy versions shipped with the application. Versions are immutable. */
const POLICIES: Record<string, RoutingPolicy> = {
  [DEMO_POLICY.version]: DEMO_POLICY,
};

export const ACTIVE_POLICY_VERSION = DEMO_POLICY.version;

export function getActivePolicy(): RoutingPolicy {
  return POLICIES[ACTIVE_POLICY_VERSION]!;
}

export function getPolicyByVersion(version: string): RoutingPolicy | undefined {
  return POLICIES[version];
}

export function listPolicyVersions(): string[] {
  return Object.keys(POLICIES);
}
