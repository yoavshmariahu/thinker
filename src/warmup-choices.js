// The three answers to the warm-up offer, as the person sees them and as repo-onboard.js:answerWarmup takes
// them. Kept apart so an agent's extension (integrations/pi.js) can show them without loading the rest.
export const WARMUP_CHOICES = [
  { value: 'warm', label: 'Warm up cache', description: 'read the repository\'s history into the cache in the background' },
  { value: 'no', label: 'No', description: 'not for this repository' },
  { value: 'never', label: 'Don\'t ask again', description: 'no warm-up offers in any repository' },
];
// The offer as the prompt hook gives it to the agent
export const OFFER_BLOCK = /<thinker-new-repository>[\s\S]*?<\/thinker-new-repository>\n*/;
