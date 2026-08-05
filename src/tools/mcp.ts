import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseCoverage, ShellTestRunner, type TestRunner, type TestRunResult } from "./testRunner.js";
import { checkPermission } from "./permissions.js";
import { executeBash, type BashOptions } from "./bash.js";

export interface MCPToolProperty {
  type: string;
  description: string;
  enum?: string[];
  items?: { type: string };
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, MCPToolProperty | Record<string, unknown>>;
    required?: string[];
  };
}

export const SHELL_EXECUTION_TOOL: MCPToolDefinition = {
  name: "execute_shell_command",
  description: "Execute shell commands, system utilities, terminal commands, and scripts on the machine. Select this tool whenever the user task requires running command-line actions, bash operations, or system utilities.",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell or bash command string to execute.",
      },
      cwd: {
        type: "string",
        description: "Working directory path for command execution.",
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds for process execution.",
      },
    },
    required: ["command"],
  },
};

export const AUTOMATED_ML_TOOL: MCPToolDefinition = {
  name: "automated_ml_training_and_evaluation",
  description: "Train and evaluate machine-learning models on a local tabular dataset. Select this tool, rather than shell execution, for classification or regression training, model selection, and evaluation metrics. Requires a dataset path and target column.",
  inputSchema: {
    type: "object",
    properties: {
      datasetPath: {
        type: "string",
        description: "Path to dataset file (CSV, JSON, Parquet) for ML model training.",
      },
      targetColumn: {
        type: "string",
        description: "Target variable or label column name in the dataset.",
      },
      taskType: {
        type: "string",
        enum: ["classification", "regression", "auto"],
        description: "Type of machine learning problem.",
      },
      modelType: {
        type: "string",
        description: "Machine learning algorithm/model type (e.g. random_forest, linear, auto).",
      },
      epochs: {
        type: "number",
        description: "Number of training iterations for supported estimators.",
      },
      testSize: {
        type: "number",
        description: "Proportion of dataset reserved for evaluation (e.g. 0.2).",
      },
    },
    required: ["datasetPath", "targetColumn"],
  },
};

export const MCP_TOOLS: MCPToolDefinition[] = [
  SHELL_EXECUTION_TOOL,
  AUTOMATED_ML_TOOL,
];

export async function handleShellExecution(args: { command: string; cwd?: string; timeout?: number }) {
  const gate = checkPermission("mcp:execute_shell_command");
  if (!gate.allowed) {
    return { isError: true, content: [{ type: "text", text: `Permission denied: ${gate.reason}` }] };
  }
  const opts: BashOptions = { cwd: args.cwd, timeout: args.timeout };
  const result = await executeBash(args.command, opts);
  return {
    isError: result.exitCode !== 0,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          error: result.error,
        }, null, 2),
      },
    ],
  };
}

const ML_TRAINING_SCRIPT = `
import json, sys
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LinearRegression, LogisticRegression
from sklearn.metrics import accuracy_score, f1_score, mean_absolute_error, mean_squared_error, r2_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder
from sklearn.model_selection import train_test_split

args = json.loads(sys.argv[1])
path = args["datasetPath"]
target = args["targetColumn"]
if path.endswith(".json"):
    data = pd.read_json(path)
elif path.endswith(".parquet"):
    data = pd.read_parquet(path)
else:
    data = pd.read_csv(path)
if target not in data.columns:
    raise ValueError("target column not found: " + target)
y = data.pop(target)
requested_task = args.get("taskType", "auto")
task = requested_task if requested_task != "auto" else ("regression" if pd.api.types.is_numeric_dtype(y) and y.nunique() > 20 else "classification")
test_size = float(args.get("testSize", 0.2))
if not 0 < test_size < 1:
    raise ValueError("testSize must be between 0 and 1")
X_train, X_test, y_train, y_test = train_test_split(data, y, test_size=test_size, random_state=42, stratify=y if task == "classification" else None)
numeric = X_train.select_dtypes(include=["number", "bool"]).columns.tolist()
categorical = [column for column in X_train.columns if column not in numeric]
preprocessor = ColumnTransformer([
    ("numeric", Pipeline([("imputer", SimpleImputer(strategy="median"))]), numeric),
    ("categorical", Pipeline([("imputer", SimpleImputer(strategy="most_frequent")), ("encode", OneHotEncoder(handle_unknown="ignore"))]), categorical),
])
model_type = args.get("modelType", "auto")
if task == "regression":
    model = LinearRegression() if model_type == "linear" else RandomForestRegressor(n_estimators=max(10, int(args.get("epochs", 100))), random_state=42)
else:
    model = LogisticRegression(max_iter=max(100, int(args.get("epochs", 100)))) if model_type == "linear" else RandomForestClassifier(n_estimators=max(10, int(args.get("epochs", 100))), random_state=42)
pipeline = Pipeline([("preprocess", preprocessor), ("model", model)])
pipeline.fit(X_train, y_train)
predictions = pipeline.predict(X_test)
metrics = ({"mse": mean_squared_error(y_test, predictions), "rmse": mean_squared_error(y_test, predictions) ** 0.5, "mae": mean_absolute_error(y_test, predictions), "r2": r2_score(y_test, predictions)} if task == "regression" else {"accuracy": accuracy_score(y_test, predictions), "f1_score": f1_score(y_test, predictions, average="weighted", zero_division=0)})
print(json.dumps({"status": "success", "taskType": task, "modelType": model_type, "datasetPath": path, "targetColumn": target, "split": {"trainRatio": 1 - test_size, "testRatio": test_size}, "metrics": metrics}))
`;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function handleMlTrainAndEvaluate(args: {
  datasetPath?: string;
  targetColumn?: string;
  taskType?: "classification" | "regression" | "auto";
  modelType?: string;
  epochs?: number;
  testSize?: number;
}) {
  const gate = checkPermission("mcp:automated_ml_training_and_evaluation");
  if (!gate.allowed) {
    return { isError: true, content: [{ type: "text", text: `Permission denied: ${gate.reason}` }] };
  }
  if (!args.datasetPath || !args.targetColumn) {
    return { isError: true, content: [{ type: "text", text: "datasetPath and targetColumn are required for ML training." }] };
  }

  const result = await executeBash(`python3 -c ${shellQuote(ML_TRAINING_SCRIPT)} ${shellQuote(JSON.stringify(args))}`);
  return {
    isError: result.exitCode !== 0,
    content: [{ type: "text", text: result.exitCode === 0 ? result.stdout : result.stderr || result.stdout }],
  };
}

/**
 * MCP-backed test/coverage runner.
 *
 * The detailed coverage-measurement loop is delegated to an external MCP
 * server over stdio (de facto standard tool-calling protocol). Configure via:
 *   NRI_MCP_SERVER_COMMAND  e.g. "npx"
 *   NRI_MCP_SERVER_ARGS     e.g. "-y @modelcontextprotocol/server-everything"
 *   NRI_MCP_TOOL            tool name override (default: first tool whose
 *                           name contains "coverage" or "test")
 *
 * If the server exposes no matching tool, falls back to ShellTestRunner so
 * the pipeline keeps working.
 */
export class McpCoverageRunner implements TestRunner {
  private client: Client | null = null;
  private toolName: string | null = null;
  private readonly fallback = new ShellTestRunner();

  constructor(
    private readonly command = process.env.NRI_MCP_SERVER_COMMAND ?? "",
    private readonly args = (process.env.NRI_MCP_SERVER_ARGS ?? "").split(" ").filter(Boolean),
  ) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.command) throw new Error("NRI_MCP_SERVER_COMMAND is not set");
    const transport = new StdioClientTransport({ command: this.command, args: this.args });
    const client = new Client({ name: "nri", version: "0.1.0" });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  private async resolveTool(client: Client): Promise<string | null> {
    if (this.toolName) return this.toolName;
    if (process.env.NRI_MCP_TOOL) {
      this.toolName = process.env.NRI_MCP_TOOL;
      return this.toolName;
    }
    const { tools } = await client.listTools();
    const match = tools.find((t) => /coverage|test/i.test(t.name));
    this.toolName = match?.name ?? null;
    return this.toolName;
  }

  async run(code: string, tests: string, iteration: number): Promise<TestRunResult> {
    let client: Client;
    try {
      client = await this.connect();
    } catch {
      return this.fallback.run(code, tests, iteration);
    }
    const toolName = await this.resolveTool(client);
    if (!toolName) return this.fallback.run(code, tests, iteration);

    const gate = checkPermission(`mcp:${toolName}`);
    if (!gate.allowed) {
      return { coverage: 0, passed: false, output: `permission denied: ${gate.reason}` };
    }
    const advisory = gate.advisory ? `[warn] ${gate.advisory}\n` : "";

    const result = await client.callTool({
      name: toolName,
      arguments: { code, tests, iteration },
    });
    const text = Array.isArray(result.content)
      ? result.content
          .map((c) => (c.type === "text" ? c.text : ""))
          .filter(Boolean)
          .join("\n")
      : String(result.content ?? "");
    const coverage = parseCoverage(text) ?? 0;
    return { coverage, passed: !result.isError, output: advisory + text };
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }
}
