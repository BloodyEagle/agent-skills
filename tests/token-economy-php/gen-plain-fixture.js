'use strict';
// Генератор нейтрального PHP-проекта (composer, без CMS) для проверки универсального режима.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'plain-site');
fs.rmSync(root, { recursive: true, force: true });

const W = (rel, text) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

W('composer.json', JSON.stringify({
  name: 'acme/plain',
  require: { php: '^8.1', 'monolog/monolog': '^3.0' },
  autoload: { 'psr-4': { 'App\\': 'src/' } },
}, null, 2) + '\n');
W('index.php', "<?php\nrequire __DIR__ . '/vendor/autoload.php';\nuse App\\Services\\Billing;\necho Billing::recalc(['qty' => 2]);\n");
W('src/Support/Helper.php', "<?php\nnamespace App\\Support;\n\nclass Helper {\n  public static function slugify(string $s): string {\n    return trim(preg_replace('/[^a-z0-9]+/i', '-', strtolower($s)), '-');\n  }\n}\n");
W('src/Services/Billing.php', "<?php\nnamespace App\\Services;\nuse App\\Support\\Helper;\n\nclass Billing {\n  public static function recalc(array $order): string {\n    return Helper::slugify((string)($order['qty'] ?? 0));\n  }\n}\n");
// vendor должен быть исключён из индекса универсальным skip-правилом
W('vendor/monolog/monolog/src/Monolog/Logger.php', "<?php\nnamespace Monolog;\nclass Logger {\n  public function info(string $m): void {}\n}\n");
W('vendor/autoload.php', "<?php\n// заглушка\n");

console.log('корень:', root);
