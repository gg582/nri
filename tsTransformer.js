import typescript from 'typescript';

export default {
  process(src, filename) {
    const result = typescript.transpileModule(src, {
      compilerOptions: {
        module: typescript.ModuleKind.CommonJS,
        target: typescript.ScriptTarget.ES2020,
        jsx: typescript.JsxEmit.React,
        esModuleInterop: true,
      },
      fileName: filename,
    });
    return {
      code: result.outputText,
    };
  },
};
