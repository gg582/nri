import { executeBash } from '../src/tools/bash';

describe('executeBash', () => {
  it('should execute a simple command successfully', async () => {
    const res = await executeBash('echo "hello world"');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('hello world');
    expect(res.stderr).toBe('');
  });

  it('should handle options like cwd and env', async () => {
    const res = await executeBash('node -e "console.log(process.env.TEST_VAR)"', {
      env: { TEST_VAR: 'test_value' },
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('test_value');
  });

  it('should handle command errors', async () => {
    const res = await executeBash('non_existent_command_xyz_123');
    expect(res.exitCode).not.toBe(0);
    expect(res.error).toBeDefined();
  });
});
