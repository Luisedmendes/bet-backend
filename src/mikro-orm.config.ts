import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { defineConfig } from '@mikro-orm/postgresql';

export default defineConfig({
    metadataProvider: ReflectMetadataProvider,
});