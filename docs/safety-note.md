# Safety note — EmergeMedicalRoute AI

This note is also shown in the app under **Settings & Safety**.

1. EmergeMedicalRoute AI is an **educational hackathon prototype**.
2. It uses **synthetic demonstration data only**. Every record and test case is invented, and identifiers are deliberately obvious (`SYN-1001`, `SYN-P-2001`).
3. It **does not diagnose, treat, or prescribe**. It only suggests an *administrative* route for staff review.
4. Its routing rules are **illustrative** ("DEMO POLICY — illustrative rules requiring qualified clinical review") and **have not been clinically validated**.
5. **Human review** is required for appropriate administrative routing. Staff make every final decision, and staff review is administrative review, not clinical approval.
6. Unclear, contradictory, incomplete, injected, negated, historical or potentially high-risk descriptions are **never automatically treated as routine**. They go to `NEEDS_CLARIFICATION_OR_HUMAN_REVIEW` or higher.
7. Emergency guidance directs people to **local emergency services immediately**. It is shown at once, never behind a modal, login, AI response or staff approval, and it stays visible even after an administrative override.
8. The application **does not contact emergency services** and is not a dispatch service. It does not invent a local emergency number; the instruction text is location-neutral and configurable (`EMERGENCY_INSTRUCTION`).
9. **AI-generated interpretations can be wrong.** The optional AI is a local Ollama model:
   - Its output is validated against a strict schema and labelled as AI-assisted.
   - It can only escalate a case to human review, never downgrade one.
   - It is skipped entirely when an emergency rule matches.
   - If it fails, times out or returns invalid output, the deterministic policy continues.
   - The **AI intake assistant** (chat) uses the same local model under stricter limits:
     - Every message passes the deterministic emergency rules first; an emergency stops the chat and shows guidance without calling the model.
     - The model may only write a one-sentence acknowledgement; the app asks every question, so the model cannot ask for identifying details.
     - Replies containing diagnosis, medication, reassurance, booking promises or "request received" claims are removed.
     - The description stays in the requester's own words, and the requester reviews and submits the normal form. The assistant never routes or submits anything.
     - If Ollama is unavailable it says so plainly; no scripted replies are presented as AI.
10. **The absence of a detected warning sign does not prove that a situation is safe.**
11. **Passing synthetic tests does not establish clinical safety.**
12. Clinical use would require **qualified healthcare review, formal validation, a security assessment, and appropriate regulatory evaluation**.

## Privacy and security notes

- The intake form never collects names, contact details, addresses, insurance identifiers or record numbers, only an age group.
- Symptom text is rendered as plain text (never HTML) and is not copied into audit messages.
- The AI model runs locally. The backend refuses non-loopback `OLLAMA_BASE_URL` values, so text is never sent to an external AI service, and the browser never talks to Ollama.
- No API keys are required or stored. `.env.example` contains placeholders only.
- Demo staff identities are **not** real authentication. No healthcare-privacy regulation compliance has been assessed.
