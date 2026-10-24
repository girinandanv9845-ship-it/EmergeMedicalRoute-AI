import { Info, PhoneCall, Siren, TriangleAlert } from 'lucide-react';

/**
 * Emergency guidance banner. Rendered immediately from the server's deterministic result —
 * never behind a modal, login, AI response or staff approval. No animation.
 */
export function EmergencyBanner({ instruction, ruleIds, policyVersion, overridden }: { instruction: string; ruleIds: string[]; policyVersion: string; overridden?: boolean }) {
  return (
    <div role="alert" aria-live="assertive" data-testid="emergency-banner" className="rounded-xl border-2 border-red-600 bg-red-50 p-5 text-red-950">
      <div className="flex items-start gap-3">
        <span className="rounded-lg bg-red-600 p-2 text-white">
          <Siren className="h-6 w-6" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-lg font-bold">Possible emergency — {instruction}</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
            <li>
              <strong>Do not wait</strong> for an appointment or a clinic callback.
            </li>
            <li>
              <strong>This prototype has NOT contacted emergency services.</strong> It is not an emergency dispatch service.
            </li>
            <li>If you are with the person, stay with them and follow the instructions of your local emergency service.</li>
          </ul>
          <p className="mt-3 text-xs text-red-900">
            Triggered by demonstration rule{ruleIds.length > 1 ? 's' : ''} <span className="font-mono">{ruleIds.join(', ')}</span> · policy {policyVersion}.
            {overridden && ' An administrative override was recorded; it does not remove the need for emergency care and this warning is preserved.'}
          </p>
        </div>
      </div>
    </div>
  );
}

export function PrecautionNotice({ instruction }: { instruction: string }) {
  return (
    <div role="note" data-testid="precaution-notice" className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
      <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" aria-hidden />
      <p>
        <strong>Precautionary notice:</strong> this request mentions a potentially high-risk symptom area. If symptoms are severe, sudden or getting rapidly worse,{' '}
        {instruction.charAt(0).toLowerCase() + instruction.slice(1)} Do not wait for a callback.
      </p>
    </div>
  );
}

/** Persistent notice shown beside the intake submit button. */
export function IntakeEmergencyNotice({ instruction }: { instruction: string }) {
  return (
    <div role="note" className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-950">
      <PhoneCall className="mt-0.5 h-5 w-5 shrink-0 text-red-700" aria-hidden />
      <p>
        <strong>This form is not an emergency service.</strong> Anyone experiencing a possible emergency should not use this form — {instruction.charAt(0).toLowerCase() + instruction.slice(1)}
      </p>
    </div>
  );
}

export function NotDiagnosisNote() {
  return (
    <p className="flex items-start gap-2 text-xs text-slate-500">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      Administrative routing suggestion under a demonstration policy. It is not a diagnosis and not clinical approval.
    </p>
  );
}
