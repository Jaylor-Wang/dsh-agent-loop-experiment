import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';
import type { ConvergenceConfig } from './index.js';

export declare const name: string;
export declare const inject: string[];
export declare const SOURCE: 'loop-convergence';
export declare const GUIDANCE: string;
export declare const REMINDER: string;
export declare const Config: z<ConvergenceConfig>;
export declare function apply(ctx: Context, config?: ConvergenceConfig): void;
declare const plugin: { name: typeof name; inject: typeof inject; Config: typeof Config; apply: typeof apply };
export default plugin;
