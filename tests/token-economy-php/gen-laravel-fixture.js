'use strict';
// Генератор минимальной Laravel-фикстуры для smoke-проверки token-economy-php.
const fs = require('fs');
const path = require('path');

const root = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, 'laravel-app');
if (fs.existsSync(root) && fs.readdirSync(root).length) throw new Error('каталог фикстуры не пуст: ' + root);
fs.mkdirSync(root, { recursive: true });

const W = (rel, text) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

W('artisan', "#!/usr/bin/env php\n<?php\ndefine('LARAVEL_START', microtime(true));\nrequire __DIR__.'/vendor/autoload.php';\n$app = require_once __DIR__.'/bootstrap/app.php';\n");
W('composer.json', JSON.stringify({ require: { php: '^8.2', 'laravel/framework': '^12.0' } }, null, 2) + '\n');
W('bootstrap/app.php', "<?php\nuse Illuminate\\Foundation\\Application;\n$app = new Application($_ENV['APP_BASE_PATH'] ?? dirname(__DIR__));\nreturn $app;\n");
W('routes/web.php', "<?php\nuse App\\Http\\Controllers\\PostController;\nuse Illuminate\\Support\\Facades\\Route;\n\nRoute::get('/posts', [PostController::class, 'index'])->name('posts.index');\nRoute::get('/posts/{post}', [PostController::class, 'show'])->name('posts.show');\nRoute::resource('comments', CommentController::class)->only(['index', 'store']);\nRoute::get('/about', function () { return view('pages.about'); })->name('about');\n");
W('app/Models/Post.php', "<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\n\nclass Post extends Model {\n  protected $table = 'posts';\n  protected $fillable = ['title', 'body', 'user_id'];\n  public function comments() { return $this->hasMany(Comment::class); }\n  public function author() { return $this->belongsTo(User::class, 'user_id'); }\n  public function scopePublished($query) { return $query->whereNotNull('published_at'); }\n}\n");
W('app/Models/Comment.php', "<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\n\nclass Comment extends Model {\n  protected $fillable = ['post_id', 'text'];\n  public function post() { return $this->belongsTo(Post::class); }\n}\n");
W('database/migrations/2026_01_01_000000_create_posts_table.php', "<?php\nuse Illuminate\\Database\\Migrations\\Migration;\nuse Illuminate\\Database\\Schema\\Blueprint;\nuse Illuminate\\Support\\Facades\\Schema;\n\nreturn new class extends Migration {\n  public function up(): void {\n    Schema::create('posts', function (Blueprint $table) {\n      $table->id();\n      $table->string('title');\n      $table->text('body');\n      $table->foreignId('user_id')->constrained();\n      $table->timestamps();\n    });\n  }\n};\n");
W('app/Http/Controllers/PostController.php', "<?php\nnamespace App\\Http\\Controllers;\nuse App\\Models\\Post;\n\nclass PostController extends Controller {\n  public function index() {\n    $posts = Post::published()->orderBy('title')->get();\n    return view('posts.index', ['posts' => $posts]);\n  }\n  public function show(Post $post) { return view('posts.show', ['post' => $post]); }\n}\n");
W('resources/views/layouts/app.blade.php', "<!doctype html>\n<html><body>\n@yield('content')\n</body></html>\n");
W('resources/views/posts/index.blade.php', "@extends('layouts.app')\n@section('content')\n@foreach ($posts as $p)\n  <h2>{{ $p->title }}</h2>\n@endforeach\n@lang('posts.title')\n@endsection\n");
W('lang/ru/posts.php', "<?php\nreturn ['title' => 'Записи', 'created' => 'Создано'];\n");

console.log('корень:', root);
