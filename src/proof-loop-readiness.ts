export type ProofLoopReadiness = {
  status: "pass" | "warn" | "fail";
  detail: string;
};

export function evaluateProofLoopReadiness(input: {
  databaseReady: boolean;
  aiReady: boolean;
  twilioReady: boolean;
  ownerAlertsReady: boolean;
  callbackReady: boolean;
  paymentReady: boolean;
  completeProofCalls: number;
}): ProofLoopReadiness {
  const prerequisitesReady = input.databaseReady
    && input.aiReady
    && input.twilioReady
    && input.ownerAlertsReady
    && input.callbackReady
    && input.paymentReady;

  if (!prerequisitesReady) {
    return {
      status: "fail",
      detail: "Not ready for an end-to-end proof call yet — fix the failed dependency checks above first.",
    };
  }

  if (input.completeProofCalls <= 0) {
    return {
      status: "warn",
      detail: "Ready for a proof call. Place one controlled call to verify the summary, owner alert, and callback task chain.",
    };
  }

  return {
    status: "pass",
    detail: `${input.completeProofCalls} complete proof call${input.completeProofCalls === 1 ? "" : "s"} verified with a summary, owner alert, and follow-up task.`,
  };
}
