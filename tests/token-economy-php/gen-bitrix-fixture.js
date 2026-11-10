'use strict';
// Генератор минимальной Битрикс-фикстуры для регрессионных прогонов token-economy-php.
const fs = require('fs');
const path = require('path');

const root = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, 'bitrix-site');
if (fs.existsSync(root) && fs.readdirSync(root).length) throw new Error('каталог фикстуры не пуст: ' + root);
fs.mkdirSync(root, { recursive: true });

const W = (rel, text) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

W('index.php', "<?php\nrequire $_SERVER['DOCUMENT_ROOT'] . '/bitrix/modules/main/include/prolog_before.php';\n$APPLICATION->IncludeComponent('demo:list', '', ['COUNT' => 10]);\nrequire $_SERVER['DOCUMENT_ROOT'] . '/bitrix/modules/main/include/epilog_after.php';\n");
W('local/components/demo/list/class.php', "<?php\nnamespace Demo\\Components;\nuse Bitrix\\Main\\Loader;\n\nclass DemoListComponent extends \\CBitrixComponent {\n  public function executeComponent() {\n    Loader::includeModule('demo');\n    $this->arResult['ITEMS'] = \\Demo\\Helper::fetch((int)$this->arParams['COUNT']);\n    $this->includeComponentTemplate();\n  }\n}\n");
W('local/components/demo/list/.parameters.php', "<?php\nreturn [\n  'PARAMS' => [\n    'COUNT' => ['NAME' => 'Количество', 'TYPE' => 'string', 'DEFAULT' => '10'],\n  ],\n];\n");
W('local/components/demo/list/templates/.default/template.php', "<?php\nif (!defined('B_PROLOG_INCLUDED') || B_PROLOG_INCLUDED !== true) die();\n/** @var array $arResult */\nforeach ($arResult['ITEMS'] as $item) {\n  echo GetMessage('DEMO_ITEM') . ': ' . $item['TITLE'] . '<br>';\n}\n");
W('local/modules/demo/install/index.php', "<?php\nnamespace Demo;\nclass demo extends \\CModule {\n  var $MODULE_ID = 'demo';\n  function DoInstall() { RegisterModuleDependences('main', 'OnPageStart', $this->MODULE_ID, '\\\\Demo\\\\Handlers', 'onPageStart'); }\n}\n");
W('local/modules/demo/install/db/mysql/install.sql', "CREATE TABLE b_demo_item (\n  ID int not null auto_increment,\n  TITLE varchar(255) not null,\n  primary key (ID)\n);\n");
W('local/php_interface/init.php', "<?php\nclass Handlers {\n  public static function onPageStart() { \\Bitrix\\Main\\Loader::includeModule('demo'); }\n  public static function onAfterItemAdd(array $fields) {}\n}\nAddEventHandler('demo', 'OnAfterItemAdd', ['Handlers', 'onAfterItemAdd']);\n");
W('local/php_interface/include/helpers.php', "<?php\nnamespace Demo;\nclass Helper {\n  public static function fetch(int $count): array { return []; }\n}\n");
W('local/news/detail.php', "<?php\n$APPLICATION->IncludeComponent('demo:list', 'cards', ['COUNT' => 5]);\n$MESS['NEWS_TITLE'] = 'Новости';\n");
W('local/news/lang/ru/detail.php', "<?php\n$MESS['NEWS_TITLE'] = 'Новости';\n");
W('urlrewrite.php', "<?php\n$arUrlRewrite = [\n  ['CONDITION' => '#^/catalog/(.*)#i', 'RULE' => 'code=\$1', 'ID' => '', 'PATH' => '/local/news/detail.php'],\n];\n");
W('bitrix/modules/main/classes/general/version.php', "<?php\ndefine('SM_VERSION', '23.0.0');\n");
W('bitrix/.settings.php', "<?php\nreturn ['utf_mode' => ['value' => true, 'readonly' => false]];\n");
W('bitrix/php_interface/dbconn.php', "<?php\ndefine('BX_UTF', true);\n");
W('bitrix/templates/demo/header.php', "<?php\n$APPLICATION->ShowTitle();\n");
W('bitrix/templates/demo/footer.php', "<?php\nrequire $_SERVER['DOCUMENT_ROOT'] . '/bitrix/modules/main/include/epilog_after.php';\n");

console.log('корень:', root);
