import type { Plugin } from '@deepseek-ai/cordis';
import type { MessageSource } from '@deepseek-ai/dsh-llm';
import experiment, { type ExperimentConfig } from 'dsh-agent-loop-experiment';
import baseline from 'dsh-agent-loop-experiment/baseline';
import policy from 'dsh-agent-loop-experiment/policy';
import replacement, { type ReplacementConfig } from 'dsh-agent-loop-experiment/replacement';

const configuration: ExperimentConfig = {
  loop: { maxParallelToolCalls: 4, agents: [] },
  convergence: { enabled: true, softStepBudget: 8, recoverFailedWrites: true }
};
const plugins: Plugin[] = [experiment, baseline, policy, replacement];
const replacementConfiguration: ReplacementConfig = { agents: [], maxParallelToolCalls: 10, convergence: { enabled: true } };
const source: MessageSource = { kind: 'loop-convergence', form: 'notice', summary: 'Reassess remaining work.' };
void configuration;
void plugins;
void source;
void replacementConfiguration;
const recoverySource: MessageSource = { kind: 'loop-write-recovery', form: 'notice', summary: 'Reuse the failed write.', callId: 'failed' };
void recoverySource;
