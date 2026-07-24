import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatXAI } from "@langchain/xai";
import { ChatDeepSeek } from "@langchain/deepseek";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage, AIMessage, BaseMessage } from "@langchain/core/messages";
import { BaseProviderStrategy, type ChatMessage, type InvokeOptions } from "./base.js";

/** Explicit per-strategy overrides (from CLI, config, or model routing). */
export interface StrategyOptions {
  model?: string;
  apiKey?: string;
  baseURL?: string;
  /** Credential mechanism hint from config, e.g. "codex-oauth". */
  auth?: string;
}

function toLangChainMessages(messages: ChatMessage[]): BaseMessage[] {
  return messages.map((m) => {
    switch (m.role) {
      case "system":
        return new SystemMessage(m.content);
      case "assistant":
        return new AIMessage(m.content);
      default:
        return new HumanMessage(m.content);
    }
  });
}

function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : ""))
      .join("");
  }
  return String(content ?? "");
}

/**
 * Base for strategies backed by a provider-NATIVE LangChain chat model
 * (Gemini, Grok, DeepSeek, Claude). Each subclass builds its SDK client
 * per invoke so per-call temperature/maxTokens overrides stay type-safe.
 */
abstract class NativeChatStrategy extends BaseProviderStrategy {
  abstract readonly name: string;
  abstract readonly model: string;

  protected abstract createClient(opts?: InvokeOptions): BaseChatModel;

  async invoke(messages: ChatMessage[], opts?: InvokeOptions): Promise<string> {
    const res = await this.createClient(opts).invoke(toLangChainMessages(messages));
    return contentToString(res.content);
  }
}

/**
 * Strategy for providers whose official API is OpenAI-compatible and which
 * have no native LangChain package (Moonshot Kimi). Also used for OpenAI
 * itself, where ChatOpenAI IS the native client.
 */
export class OpenAICompatibleStrategy extends BaseProviderStrategy {
  readonly name: string;
  readonly model: string;
  private readonly args: {
    name: string;
    model: string;
    apiKey: string;
    baseURL?: string;
    defaultTemperature?: number;
  };

  constructor(args: {
    name: string;
    model: string;
    apiKey: string;
    baseURL?: string;
    defaultTemperature?: number;
  }) {
    super();
    this.name = args.name;
    this.model = args.model;
    this.args = args;
  }

  private createClient(opts?: InvokeOptions): ChatOpenAI {
    // gpt-5 / o-series reject `temperature` (only the default 1 is allowed) and
    // the legacy `max_tokens` param. LangChain's isReasoningModel regex only
    // covers o-series, so handle it here: omit temperature and pass
    // max_completion_tokens through modelKwargs.
    const fixedSampling = /^(gpt-5|o\d)/i.test(this.args.model);
    return new ChatOpenAI({
      model: this.args.model,
      apiKey: this.args.apiKey,
      configuration: this.args.baseURL ? { baseURL: this.args.baseURL } : undefined,
      ...(fixedSampling
        ? { modelKwargs: opts?.maxTokens ? { max_completion_tokens: opts.maxTokens } : {} }
        : {
            temperature: opts?.temperature ?? this.args.defaultTemperature ?? 0,
            maxTokens: opts?.maxTokens,
          }),
    });
  }

  async invoke(messages: ChatMessage[], opts?: InvokeOptions): Promise<string> {
    const res = await this.createClient(opts).invoke(toLangChainMessages(messages));
    return contentToString(res.content);
  }
}

/** OpenAI (ChatGPT). Env: OPENAI_API_KEY. */
export class OpenAIStrategy extends OpenAICompatibleStrategy {
  constructor(opts: StrategyOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
    super({
      name: "openai",
      model: opts.model ?? process.env.NRI_MODEL ?? "gpt-4o",
      apiKey,
      baseURL: opts.baseURL,
    });
  }
}

/**
 * Google Gemini — native SDK via @langchain/google-genai.
 * Env: GEMINI_API_KEY (or GOOGLE_API_KEY).
 */
export class GeminiStrategy extends NativeChatStrategy {
  readonly name = "gemini";
  readonly model: string;
  private readonly apiKey: string;

  constructor(opts: StrategyOptions = {}) {
    super();
    const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY (or GOOGLE_API_KEY) is not set");
    this.model = opts.model ?? process.env.NRI_MODEL ?? "gemini-2.5-flash";
    this.apiKey = apiKey;
  }

  protected createClient(opts?: InvokeOptions): BaseChatModel {
    return new ChatGoogleGenerativeAI({
      model: this.model,
      apiKey: this.apiKey,
      temperature: opts?.temperature ?? 0,
      maxOutputTokens: opts?.maxTokens,
    });
  }
}

/**
 * Moonshot Kimi. Moonshot's official API is OpenAI-compatible and has no
 * native JS SDK / LangChain package, so ChatOpenAI against api.moonshot.ai
 * is the real, documented implementation.
 * Env: KIMI_API_KEY (or MOONSHOT_API_KEY). Base URL overridable (e.g. a
 * Kimi-for-Coding endpoint imported from kimi-code).
 */
export class KimiStrategy extends OpenAICompatibleStrategy {
  constructor(opts: StrategyOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.KIMI_API_KEY ?? process.env.MOONSHOT_API_KEY;
    if (!apiKey) throw new Error("KIMI_API_KEY (or MOONSHOT_API_KEY) is not set");
    super({
      name: "kimi",
      model: opts.model ?? process.env.NRI_MODEL ?? "kimi-k2-0905-preview",
      apiKey,
      baseURL: opts.baseURL ?? process.env.KIMI_BASE_URL ?? "https://api.moonshot.ai/v1",
    });
  }
}

/** DeepSeek — native SDK via @langchain/deepseek. Env: DEEPSEEK_API_KEY. */
export class DeepSeekStrategy extends NativeChatStrategy {
  readonly name = "deepseek";
  readonly model: string;
  private readonly apiKey: string;

  constructor(opts: StrategyOptions = {}) {
    super();
    const apiKey = opts.apiKey ?? process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not set");
    this.model = opts.model ?? process.env.NRI_MODEL ?? "deepseek-chat";
    this.apiKey = apiKey;
  }

  protected createClient(opts?: InvokeOptions): BaseChatModel {
    return new ChatDeepSeek({
      model: this.model,
      apiKey: this.apiKey,
      temperature: opts?.temperature ?? 0,
      maxTokens: opts?.maxTokens,
    });
  }
}

/** xAI Grok — native SDK via @langchain/xai. Env: XAI_API_KEY (or GROK_API_KEY). */
export class GrokStrategy extends NativeChatStrategy {
  readonly name = "grok";
  readonly model: string;
  private readonly apiKey: string;

  constructor(opts: StrategyOptions = {}) {
    super();
    const apiKey = opts.apiKey ?? process.env.XAI_API_KEY ?? process.env.GROK_API_KEY;
    if (!apiKey) throw new Error("XAI_API_KEY (or GROK_API_KEY) is not set");
    this.model = opts.model ?? process.env.NRI_MODEL ?? "grok-4";
    this.apiKey = apiKey;
  }

  protected createClient(opts?: InvokeOptions): BaseChatModel {
    return new ChatXAI({
      model: this.model,
      apiKey: this.apiKey,
      temperature: opts?.temperature ?? 0,
      maxTokens: opts?.maxTokens,
    });
  }
}

/** Anthropic Claude — native SDK via @langchain/anthropic. Env: ANTHROPIC_API_KEY. */
export class ClaudeStrategy extends NativeChatStrategy {
  readonly name = "claude";
  readonly model: string;
  private readonly apiKey: string;

  constructor(opts: StrategyOptions = {}) {
    super();
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    this.model = opts.model ?? process.env.NRI_MODEL ?? "claude-sonnet-4-20250514";
    this.apiKey = apiKey;
  }

  protected createClient(opts?: InvokeOptions): BaseChatModel {
    return new ChatAnthropic({
      model: this.model,
      apiKey: this.apiKey,
      temperature: opts?.temperature ?? 0,
      maxTokens: opts?.maxTokens,
    });
  }
}
