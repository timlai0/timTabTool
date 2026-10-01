import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rootDir = path.resolve(__dirname, '..');
const manifestPath = path.join(rootDir, 'manifest.json');
const firefoxManifestPath = path.join(rootDir, 'dist-firefox', 'manifest.json');

console.log('🤖 Transforming manifest.json for Firefox...');

try {
  // Read original manifest
  const manifestData = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestData);

  // 1. Modify permissions (remove Chrome-specific "favicon" permission, ensure Firefox "menus" permission)
  if (manifest.permissions) {
    manifest.permissions = manifest.permissions.filter(p => p !== 'favicon');
    if (!manifest.permissions.includes('menus')) {
      manifest.permissions.push('menus');
    }
  }

  // 2. Modify web_accessible_resources (remove Chrome-specific _favicon resource)
  if (manifest.web_accessible_resources) {
    manifest.web_accessible_resources = manifest.web_accessible_resources.filter(resource => {
      if (resource.resources && resource.resources.includes('_favicon/*')) {
        return false;
      }
      return true;
    });

    if (manifest.web_accessible_resources.length === 0) {
      delete manifest.web_accessible_resources;
    }
  }

  // 3. Update background script configuration for Firefox
  // Firefox supports service_worker in MV3, but 'scripts' is much more stable and
  // standard for extension builds without CRXJS loaders.
  manifest.background = {
    scripts: ['background.js'],
    type: 'module'
  };

  // 4. Remove static content_scripts for Firefox to prevent 2000+ tab memory leaks (loaded dynamically on demand via scripting.executeScript)
  delete manifest.content_scripts;

  // 5. Add Firefox browser_specific_settings (Gecko ID is MANDATORY for Firefox MV3)
  manifest.browser_specific_settings = {
    gecko: {
      id: 'timtabtool@timlai.de',
      strict_min_version: '142.0',
      data_collection_permissions: {
        required: ['none']
      }
    }
  };

  // Ensure output directory exists
  const distDir = path.dirname(firefoxManifestPath);
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  // Write new manifest
  fs.writeFileSync(firefoxManifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log('✅ Firefox manifest generated successfully in dist-firefox/manifest.json');
} catch (error) {
  console.error('❌ Error generating Firefox manifest:', error);
  process.exit(1);
}
