export const METHODS_FIRST_READING_PROFILE = 'configured-reading-2.3';
export const DEFAULT_CONFIGURED_INSTRUCTION_PROFILE = METHODS_FIRST_READING_PROFILE;

const configuredProfiles = Object.freeze({
  'configured-reading-2.2': Object.freeze({
    allowCreation: false,
    editor: 'reading-editor-1.4',
    sciencePrompt: 'science-configured-2.2.md',
    readingPrompt: 'reading-configured-2.2.md',
    executionLedger: true,
    resultsToolPreflight: true,
  }),
  [METHODS_FIRST_READING_PROFILE]: Object.freeze({
    allowCreation: true,
    editor: 'reading-editor-1.5',
    sciencePrompt: 'science-configured-2.3.md',
    readingPrompt: 'reading-configured-2.3.md',
    executionLedger: true,
    resultsToolPreflight: true,
  }),
});

export const isSupportedConfiguredReadingProfile = profile =>
  typeof profile === 'string' && Object.hasOwn(configuredProfiles, profile);

export const canCreateConfiguredReadingProfile = profile =>
  isSupportedConfiguredReadingProfile(profile) && configuredProfiles[profile].allowCreation;

export function configuredReadingProfile(profile, { creating = false } = {}) {
  if (creating ? !canCreateConfiguredReadingProfile(profile) : !isSupportedConfiguredReadingProfile(profile)) {
    const code = 'READING_BINDING_RETIRED';
    if (creating && isSupportedConfiguredReadingProfile(profile)) {
      const message = `新阅读请使用 ${DEFAULT_CONFIGURED_INSTRUCTION_PROFILE}，也可省略版本。`;
      throw Object.assign(new Error(`${code}：${message}`), { code, details: { message, replacement: DEFAULT_CONFIGURED_INSTRUCTION_PROFILE } });
    }
    throw Object.assign(new Error(code), { code });
  }
  return configuredProfiles[profile];
}

export const configuredEditorProfile = profile => configuredReadingProfile(profile).editor;
export const isMethodsFirstReadingProfile = profile => profile === METHODS_FIRST_READING_PROFILE;
export const configuredReadingUsesExecutionLedger = profile =>
  isSupportedConfiguredReadingProfile(profile) && configuredProfiles[profile].executionLedger;
export const configuredReadingRequiresResultsTools = profile =>
  isSupportedConfiguredReadingProfile(profile) && configuredProfiles[profile].resultsToolPreflight;
