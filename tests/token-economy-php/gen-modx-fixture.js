'use strict';
// Генератор MODX-фикстуры для проверки token-economy-php в деградационном режиме.
// Запуск: node gen-modx-fixture.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'modx-site');
fs.rmSync(root, { recursive: true, force: true });

const W = (rel, text) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

// --- структура MODX Revolution ---
W('config.core.php', "<?php\ndefine('MODX_CORE_PATH', dirname(__FILE__) . '/core/');\n");
W('core/config/config.inc.php', "<?php\n$dbase = 'modx_db';\n$database_user = 'modx';\n$database_password = 'secret';\n");
W('core/composer.json', JSON.stringify({ name: 'modx/revolution', version: '3.1.2-pl' }, null, 2) + '\n');
W('core/model/modx/modx.class.php', "<?php\nnamespace MODX\\Revolution;\nclass modX {\n  public $config = [];\n  public function runSnippet($snipName, array $params = []) { return ''; }\n  public function getChunk($name, array $properties = []) { return ''; }\n  public function invokeEvent($eventName, array $params = []) { return true; }\n  public function getObject($className, $criteria = null) { return null; }\n}\n");
W('core/model/modx/modsnippet.class.php', "<?php\nnamespace MODX\\Revolution;\nclass modSnippet extends modElement {\n  public function process(array $properties = [], $content = null) { return ''; }\n}\n");
W('core/model/modx/modelement.class.php', "<?php\nnamespace MODX\\Revolution;\nabstract class modElement extends modAccessibleSimpleObject {\n  public $name = '';\n}\n");
W('core/model/modx/modaccessiblesimpleobject.class.php', "<?php\nnamespace MODX\\Revolution;\nabstract class modAccessibleSimpleObject extends modAccessibleObject {}\n");
W('core/model/modx/modaccessibleobject.class.php', "<?php\nnamespace MODX\\Revolution;\nabstract class modAccessibleObject extends xPDO\\Om\\xPDOObject {}\n");

// manager / connectors / assets
W('manager/controllers/default/welcome.php', "<?php\nclass WelcomeManagerController extends modManagerController {\n  public function process(array $scriptProperties = []) {}\n}\n");
W('manager/index.php', "<?php\nrequire dirname(__DIR__) . '/core/config/config.inc.php';\n");
W('connectors/index.php', "<?php\nrequire dirname(__DIR__) . '/core/config/config.inc.php';\n");
W('assets/components/mysnippet/snippet.php', "<?php\nfunction myHelper(array $items) {\n  return implode(', ', array_column($items, 'title'));\n}\n$out = $modx->runSnippet('hello', ['name' => 'мир']);\n$hdr = $modx->getChunk('headerChunk');\n");
W('core/components/acme/elements/snippets/hello.php', "<?php\n// файловый сниппет acme:hello\nreturn 'Привет, ' . ($scriptProperties['name'] ?? 'незнакомец');\n");
W('core/components/acme/elements/chunks/headerChunk.tpl', "<header>\n  [[++site_name]]\n  [[!pdoMenu? &level=`2`]]\n</header>\n");

// шаблон с тегами MODX и Fenom
W('templates/base.tpl', "<!doctype html>\n[[!pdoMenu? &showHidden=`1` &level=`2`]]\n{include 'file:chunks/headerChunk.tpl'}\n[[$headerChunk]]\n[[hello]]\n[[++site_name]] [[*pagetitle]] [[+content]]\n");

// --- ядро MODX 3.x: core/vendor (composer) — масса мелких PHP-файлов ---
const vendorPkgs = ['symfony/console', 'symfony/http-foundation', 'doctrine/orm', 'twig/twig', 'league/flysystem', 'psr/log', 'composer/composer'];
let n = 0;
const TOTAL = 1800;
for (let i = 0; i < TOTAL; i++) {
  const pkg = vendorPkgs[i % vendorPkgs.length];
  const cls = 'Gen' + i;
  const ns = 'Symfony\\Component\\Gen' + (i % 7);
  W(`core/vendor/${pkg}/src/Unit${i % 40}/Class${i}.php`,
    "<?php\nnamespace " + ns + ";\nuse Symfony\\Component\\Console\\Application;\nclass " + cls + " extends Application {\n  public function run(): int { return 0; }\n  private ?int $opt = null;\n}\n");
  n++;
}

// core/cache — обычно игнорируется, но в скилл-индекс не исключён
W('core/cache/includes/elements/modsnippet/10.include.php', "<?php\n// закэшированный сниппет\nfunction cachedSnippetHelper() { return 1; }\n");

console.log('создано файлов:', n + 12);
console.log('корень:', root);
