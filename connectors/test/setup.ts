import { httpRuntime } from '../src/http';

// Retry tests must not wait for real backoff.
httpRuntime.sleep = async () => {};
