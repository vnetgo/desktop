import * as path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import log from 'electron-log/main';
import { pathAccessible } from './utils';
import { app } from 'electron';

type ProcessCallbacks = {
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
};

/**
 * Manages a virtual Python environment using uv.
 */
export class VirtualEnvironment {
  readonly venvRootPath: string;
  readonly venvPath: string;
  readonly pythonVersion: string;
  readonly uvPath: string;
  readonly requirementsCompiledPath: string;
  readonly cacheDir: string;
  readonly pythonInterpreterPath: string;
  readonly comfyUIRequirementsPath: string;
  readonly comfyUIManagerRequirementsPath: string;

  constructor(venvPath: string, pythonVersion: string = '3.12.4') {
    this.venvRootPath = venvPath;
    this.venvPath = path.join(venvPath, '.venv'); // uv defaults to .venv
    const resourcesPath = app.isPackaged ? path.join(process.resourcesPath) : path.join(app.getAppPath(), 'assets');
    this.comfyUIRequirementsPath = path.join(resourcesPath, 'ComfyUI', 'requirements.txt');
    this.comfyUIManagerRequirementsPath = path.join(
      resourcesPath,
      'ComfyUI',
      'custom_nodes',
      'manager-core',
      'requirements.txt'
    );

    this.pythonVersion = pythonVersion;
    this.cacheDir = path.join(venvPath, 'uv-cache');
    this.requirementsCompiledPath = path.join(resourcesPath, 'requirements.compiled');
    this.pythonInterpreterPath =
      process.platform === 'win32'
        ? path.join(this.venvPath, 'Scripts', 'python.exe')
        : path.join(this.venvPath, 'bin', 'python');

    const uvFolder = app.isPackaged
      ? path.join(process.resourcesPath, 'uv')
      : path.join(app.getAppPath(), 'assets', 'uv');

    if (process.platform === 'win32') {
      this.uvPath = path.join(uvFolder, 'win', 'uv.exe');
    } else if (process.platform === 'linux') {
      this.uvPath = path.join(uvFolder, 'linux', 'uv');
    } else if (process.platform === 'darwin') {
      this.uvPath = path.join(uvFolder, 'macos', 'uv');
    } else {
      throw new Error(`Unsupported platform: ${process.platform}`);
    }
    log.info(`Using uv at ${this.uvPath}`);
  }

  public async create(callbacks?: ProcessCallbacks): Promise<void> {
    try {
      if (await this.exists()) {
        log.info(`Virtual environment already exists at ${this.venvPath}`);
        return;
      }

      log.info(`Creating virtual environment at ${this.venvPath} with python ${this.pythonVersion}`);

      // Create virtual environment using uv
      const args = ['venv', '--python', this.pythonVersion];
      const { exitCode } = await this.runUvCommandAsync(args, callbacks);

      if (exitCode !== 0) {
        throw new Error(`Failed to create virtual environment: exit code ${exitCode}`);
      }

      log.info(`Successfully created virtual environment at ${this.venvPath}`);
    } catch (error) {
      log.error(`Error creating virtual environment: ${error}`);
      throw error;
    }

    await this.installRequirements(callbacks);
  }

  public async installRequirements(callbacks?: ProcessCallbacks): Promise<void> {
    const installCmd = ['pip', 'install', '-r', this.requirementsCompiledPath, '--index-strategy', 'unsafe-best-match'];

    const { exitCode } = await this.runUvCommandAsync(installCmd, callbacks);
    if (exitCode !== 0) {
      log.error(
        `Failed to install requirements.compiled: exit code ${exitCode}. Falling back to installing requirements.txt`
      );

      await this.installComfyUIRequirements(callbacks);
      await this.installComfyUIManagerRequirements(callbacks);
    }
  }

  /**
   * Runs a python command using the virtual environment's python interpreter.
   * @param args
   * @returns
   */
  public runPythonCommand(args: string[], callbacks?: ProcessCallbacks): ChildProcess {
    const pythonInterpreterPath =
      process.platform === 'win32'
        ? path.join(this.venvPath, 'Scripts', 'python.exe')
        : path.join(this.venvPath, 'bin', 'python');

    return this.runCommand(pythonInterpreterPath, args, {}, callbacks);
  }

  /**
   * Runs a python command using the virtual environment's python interpreter and returns a promise with the exit code.
   * @param args
   * @returns
   */
  public async runPythonCommandAsync(
    args: string[],
    callbacks?: ProcessCallbacks
  ): Promise<{ exitCode: number | null }> {
    return this.runCommandAsync(this.pythonInterpreterPath, args, {}, callbacks);
  }

  /**
   * Runs a uv command with the virtual environment set to this instance's venv and returns a promise with the exit code.
   * @param args
   * @returns
   */
  public async runUvCommandAsync(args: string[], callbacks?: ProcessCallbacks): Promise<{ exitCode: number | null }> {
    return new Promise((resolve, reject) => {
      const childProcess = this.runUvCommand(args, callbacks);
      childProcess.on('close', (code) => {
        resolve({ exitCode: code });
      });

      childProcess.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Runs a uv command with the virtual environment set to this instance's venv.
   * @param args
   * @returns
   */
  public runUvCommand(args: string[], callbacks?: ProcessCallbacks): ChildProcess {
    return this.runCommand(
      this.uvPath,
      args,
      {
        UV_CACHE_DIR: this.cacheDir,
        UV_TOOL_DIR: this.cacheDir,
        UV_TOOL_BIN_DIR: this.cacheDir,
        UV_PYTHON_INSTALL_DIR: this.cacheDir,
        VIRTUAL_ENV: this.venvPath,
      },
      callbacks
    );
  }

  private runCommand(
    command: string,
    args: string[],
    env: Record<string, string>,
    callbacks?: ProcessCallbacks
  ): ChildProcess {
    log.info(`Running command: ${command} ${args.join(' ')} in ${this.venvRootPath}`);
    const childProcess: ChildProcess = spawn(command, args, {
      cwd: this.venvRootPath,
      env: {
        ...process.env,
        ...env,
      },
    });

    if (callbacks) {
      childProcess.stdout?.on('data', (data) => {
        console.log(data.toString());
        callbacks.onStdout?.(data.toString());
      });

      childProcess.stderr?.on('data', (data) => {
        console.log(data.toString());
        callbacks.onStderr?.(data.toString());
      });
    }

    return childProcess;
  }

  private async runCommandAsync(
    command: string,
    args: string[],
    env: Record<string, string>,
    callbacks?: ProcessCallbacks
  ): Promise<{ exitCode: number | null }> {
    return new Promise((resolve, reject) => {
      const childProcess = this.runCommand(command, args, env, callbacks);

      childProcess.on('close', (code) => {
        resolve({ exitCode: code });
      });

      childProcess.on('error', (err) => {
        reject(err);
      });
    });
  }

  private async installComfyUIRequirements(callbacks?: ProcessCallbacks): Promise<void> {
    if (process.platform === 'win32') {
      log.info('Installing PyTorch CUDA 12.1');
      await this.runUvCommandAsync(
        [
          'pip',
          'install',
          'torch',
          'torchvision',
          'torchaudio',
          '--index-url',
          'https://download.pytorch.org/whl/cu121',
        ],
        callbacks
      );
    }

    if (process.platform === 'darwin') {
      log.info('Installing PyTorch Nightly for macOS.');
      await this.runUvCommandAsync(
        [
          'pip',
          'install',
          'torch',
          'torchvision',
          'torchaudio',
          '--extra-index-url',
          'https://download.pytorch.org/whl/nightly/cpu',
        ],
        callbacks
      );
    }
    log.info(`Installing ComfyUI requirements from ${this.comfyUIRequirementsPath}`);
    const installCmd = ['pip', 'install', '-r', this.comfyUIRequirementsPath];
    const { exitCode } = await this.runUvCommandAsync(installCmd, callbacks);
    if (exitCode !== 0) {
      throw new Error(`Failed to install requirements.txt: exit code ${exitCode}`);
    }
  }

  private async installComfyUIManagerRequirements(callbacks?: ProcessCallbacks): Promise<void> {
    log.info(`Installing ComfyUIManager requirements from ${this.comfyUIManagerRequirementsPath}`);
    const installCmd = ['pip', 'install', '-r', this.comfyUIManagerRequirementsPath];
    const { exitCode } = await this.runUvCommandAsync(installCmd, callbacks);
    if (exitCode !== 0) {
      throw new Error(`Failed to install requirements.txt: exit code ${exitCode}`);
    }
  }

  private async exists(): Promise<boolean> {
    return await pathAccessible(this.venvPath);
  }
}