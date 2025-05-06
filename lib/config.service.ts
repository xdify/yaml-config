import { Inject, Injectable, Optional } from '@nestjs/common';
import { Subject } from 'rxjs';
import { ConfigChangeEvent } from './interfaces';
import {
  CONFIGURATION_TOKEN,
  VALIDATED_ENV_PROPNAME,
} from './config.constants';
import { NoInferType, Path, PathValue } from './types';
import { isUndefined } from '@nestjs/common/utils/shared.utils';
import get from 'lodash/get';
import has from 'lodash/has';
import set from 'lodash/set';
import * as dotenv from 'dotenv';
import fs from 'fs';

type ValidatedResult<
  WasValidated extends boolean,
  T,
> = WasValidated extends true ? T : T | undefined;

/**
 * @publicApi
 */
export interface ConfigGetOptions {
  /**
   * If present, "get" method will try to automatically
   * infer a type of property based on the type argument
   * specified at the "ConfigService" class-level (example: ConfigService<Configuration>).
   */
  infer: true;
}

type KeyOf<T> = keyof T extends never ? string | symbol : keyof T;

/**
 * @publicApi
 */
@Injectable()
export class ConfigService<
  K = Record<string | symbol, unknown>,
  WasValidated extends boolean = false,
> {
  private readonly cache: Partial<K> = {} as any;

  private readonly _changes$ = new Subject<ConfigChangeEvent>();
  private _isCacheEnabled = false;
  private _skipProcessEnv = false;
  private envFilePaths: string[] = [];

  private set isCacheEnabled(value: boolean) {
    this._isCacheEnabled = value;
  }

  private get isCacheEnabled(): boolean {
    return this._isCacheEnabled;
  }

  private set skipProcessEnv(value: boolean) {
    this._skipProcessEnv = value;
  }

  private get skipProcessEnv(): boolean {
    return this._skipProcessEnv;
  }

  constructor(
    @Optional()
    @Inject(CONFIGURATION_TOKEN)
    private readonly internalConfig: Record<string, any> = {},
  ) {}

  /**
   * Returns a stream of configuration changes.
   * Each event contains the attribute path, the old value and the new value.
   */
  get change$() {
    return this._changes$.asObservable();
  }

  /**
   * Get a configuration value (either custom configuration or process environment variable)
   * based on property path (you can use dot notation to traverse nested object, e.g. "database.host").
   * @param propertyPath
   */
  get<T = any>(propertyPath: KeyOf<K>): ValidatedResult<WasValidated, T>;

  /**
   * Get a configuration value (either custom configuration or process environment variable)
   * based on property path (you can use dot notation to traverse nested object, e.g. "database.host").
   * @param propertyPath
   * @param options
   */
  get<T = K, P extends Path<T> = any, R = PathValue<T, P>>(
    propertyPath: P,
    options: ConfigGetOptions,
  ): ValidatedResult<WasValidated, R>;

  /**
   * Get a configuration value (either custom configuration or process environment variable)
   * based on property path (you can use dot notation to traverse nested object, e.g. "database.host").
   * It returns a default value if the key does not exist.
   * @param propertyPath
   * @param defaultValue
   */
  get<T = any>(propertyPath: KeyOf<K>, defaultValue: NoInferType<T>): T;

  /**
   * Get a configuration value (either custom configuration or process environment variable)
   * based on property path (you can use dot notation to traverse nested object, e.g. "database.host").
   * It returns a default value if the key does not exist.
   * @param propertyPath
   * @param defaultValue
   * @param options
   */
  get<T = K, P extends Path<T> = any, R = PathValue<T, P>>(
    propertyPath: P,
    defaultValue: NoInferType<R>,
    options: ConfigGetOptions,
  ): Exclude<R, undefined>;

  /**
   * Get a configuration value (either custom configuration or process environment variable)
   * based on property path (you can use dot notation to traverse nested object, e.g. "database.host").
   * It returns a default value if the key does not exist.
   * @param propertyPath config key paths
   * @param defaultValueOrOptions default value
   * @param options get Options
   */
  get<T = any>(
    propertyPath: KeyOf<K>,
    defaultValueOrOptions?: T | ConfigGetOptions,
    options?: ConfigGetOptions,
  ): T | undefined {
    const internalValue = this.getFromInternalConfig(propertyPath);

    if (!isUndefined(internalValue)) {
      return internalValue;
    }

    const validatedEnvValue = this.getFromInternalConfig(propertyPath);
    if (!isUndefined(validatedEnvValue)) {
      return validatedEnvValue;
    }

    const defaultValue =
      this.isGetOptionsObject(defaultValueOrOptions as Record<string, any>) &&
      !options
        ? undefined
        : defaultValueOrOptions;

    if (!this._skipProcessEnv) {
      const processEnvValue = this.getFromProcessEnv(
        propertyPath,
        defaultValue,
      );

      if (!isUndefined(processEnvValue)) {
        return processEnvValue;
      }
    }

    return defaultValue as T;
  }

  private getFromCache<T = any>(
    propertyPath: KeyOf<K>,
    defaultValue?: T,
  ): T | undefined {
    const cachedValue = get(this.cache, propertyPath);
    return isUndefined(cachedValue)
      ? defaultValue
      : (cachedValue as unknown as T);
  }

  private setInCacheIfDefined(propertyPath: KeyOf<K>, value: any): void {
    if (typeof value === 'undefined') {
      return;
    }

    set(this.cache as Record<any, any>, propertyPath, value);
  }

  private getFromInternalConfig<T = any>(
    propertyPath: KeyOf<K>,
  ): T | undefined {
    const internalValue = get(this.internalConfig, propertyPath);
    return internalValue;
  }

  private getFromValidatedEnv<T = any>(propertyPath: KeyOf<K>): T | undefined {
    const validatedEnvValue = get(
      this.internalConfig[VALIDATED_ENV_PROPNAME],
      propertyPath,
    );

    return validatedEnvValue as unknown as T;
  }

  private getFromProcessEnv<T = any>(
    propertyPath: KeyOf<K>,
    defaultValue: any,
  ): T | undefined {
    if (
      this.isCacheEnabled &&
      has(this.cache as Record<any, any>, propertyPath)
    ) {
      const cachedValue = this.getFromCache(propertyPath, defaultValue);
      return !isUndefined(cachedValue) ? cachedValue : defaultValue;
    }

    const processValue = get(process.env, propertyPath);
    this.setInCacheIfDefined(propertyPath, processValue);

    return processValue as unknown as T;
  }

  private isGetOptionsObject(
    options: Record<string, any> | undefined,
  ): options is ConfigGetOptions {
    return options && options?.infer && Object.keys(options).length === 1;
  }

  private updateInterpolatedEnv(propertyPath: string, value: string): void {
    let config: ReturnType<typeof dotenv.parse> = {};

    for (const envFilePath of this.envFilePaths) {
      if (fs.existsSync(envFilePath)) {
        config = Object.assign(
          dotenv.parse(fs.readFileSync(envFilePath)),
          config,
        );
      }
    }

    const regex = new RegExp(`\\$\\{?${propertyPath}\\}?`, 'g');

    for (const [k, v] of Object.entries(config)) {
      if (regex.test(v)) {
        process.env[k] = v.replace(regex, value);
      }
    }
  }
}
