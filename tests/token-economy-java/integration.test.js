'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { project } = require('./helpers');

function fixture(t) {
  const p = project(t);
  const sources = {
    'pom.xml': '<project><modelVersion>4.0.0</modelVersion><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.2.0</version></parent><properties><java.version>17</java.version></properties></project>',
    'src/main/java/demo/App.java': 'package demo;\n@SpringBootApplication\npublic class App {}\n',
    'src/main/java/demo/ApiPaths.java': 'package demo;\npublic class ApiPaths { public static final String USERS = "/api/users"; }\n',
    'src/main/java/demo/UserController.java': [
      'package demo;', '@RestController', '@RequestMapping(ApiPaths.USERS)', 'public class UserController {',
      '  private final UserService service;', '  public UserController(UserService service) { this.service = service; }',
      '  @GetMapping("/{id}")', '  @PreAuthorize("hasRole(\'USER\')")',
      '  public User get(@PathVariable Long id) { return service.find(id); }',
      '  @PostMapping', '  public User create(@RequestBody User user) { return user; }', '}', ''
    ].join('\n'),
    'src/main/java/demo/UserService.java': 'package demo;\npublic interface UserService { User find(Long id); }\n',
    'src/main/java/demo/DefaultUserService.java': [
      'package demo;', '@Service', 'public class DefaultUserService implements UserService {',
      '  private final UserRepository repository;', '  public DefaultUserService(UserRepository repository) { this.repository = repository; }',
      '  @Value("${app.page-size:10}") private int pageSize;',
      '  public User find(Long id) { return repository.findById(id); }', '}', ''
    ].join('\n'),
    'src/main/java/demo/User.java': [
      'package demo;', '@Entity', '@Table(name="users")', 'public class User {',
      '  @Id @GeneratedValue private Long id;', '  @Column(name="email", unique=true) private String email;', '}', ''
    ].join('\n'),
    'src/main/java/demo/UserRepository.java': [
      'package demo;', 'public interface UserRepository extends JpaRepository<User, Long> {',
      '  @Query("select u from User u where u.email = :email")', '  User findByEmail(String email);', '}', ''
    ].join('\n'),
    'src/main/java/demo/AppConfig.java': 'package demo;\n@Configuration\npublic class AppConfig {\n  @Bean @Profile("dev") public Client client(UserService service) { return new Client(service); }\n}\n',
    'src/main/java/demo/AppProperties.java': 'package demo;\n@ConfigurationProperties(prefix="app")\npublic record AppProperties(int pageSize) {}\n',
    'src/main/java/demo/Client.java': 'package demo;\npublic class Client { public Client(UserService service) {} }\n',
    'src/main/java/demo/Events.java': [
      'package demo;', '@Component', 'public class Events {',
      '  @KafkaListener(topics="user-events", groupId="workers") public void consume(String event) {}',
      '  @EventListener public void created(UserCreatedEvent event) {}',
      '  @Scheduled(fixedDelay=1000) public void cleanup() {}', '}', ''
    ].join('\n'),
    'src/main/java/demo/UserCreatedEvent.java': 'package demo;\npublic record UserCreatedEvent(Long id) {}\n',
    'src/test/java/demo/UserServiceTest.java': 'package demo;\n@SpringBootTest\npublic class UserServiceTest { @Autowired private UserService service; }\n',
    'src/main/resources/application.yml': 'app:\n  page-size: 10\n  password: integration-private-value\n---\nspring.config.activate.on-profile: dev\napp.page-size: 20\n',
    'src/main/resources/db/migration/V1__users.sql': 'CREATE TABLE users (id BIGINT PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE);\nALTER TABLE users ADD COLUMN name VARCHAR(100);\n',
    'target/Generated.java': 'class Generated {}'
  };
  for (const [file, source] of Object.entries(sources)) p.write(file, source);
  const run = (...args) => {
    const r = p.run(...args);
    assert.equal(r.error, undefined);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.stdout;
  };
  return { ...p, query: run };
}

test('index integration: symbols, injection, implementations and affected tests', (t) => {
  const p = fixture(t);
  assert.match(p.query('op=info'), /сборка: Maven/i);
  assert.match(p.query('op=symbol', 'name=UserController#get'), /UserController#get.*method.*UserController\.java:7-9/);
  assert.match(p.query('op=deps', 'file=UserController'), /UserService\.java.*\(inject\)/);
  const reverse = p.query('op=rdeps', 'file=UserService');
  assert.match(reverse, /UserController\.java.*\(inject\)/);
  assert.match(reverse, /DefaultUserService\.java.*extends\/implements/);
  assert.match(reverse, /UserServiceTest\.java.*\[test\]/);
  assert.match(p.query('op=impls', 'name=UserService'), /DefaultUserService.*\[service\]/);
  assert.match(p.query('op=path', 'from=UserController', 'to=User'), /UserController\.java[\s\S]*User\.java/);
  assert.doesNotMatch(p.query('op=symbol', 'name=Generated'), /target\/Generated\.java/);
});

test('Spring integration: endpoints, constants, security, beans and configuration usages', (t) => {
  const p = fixture(t);
  const endpoints = p.query('op=endpoints', 'query=/api/users');
  assert.match(endpoints, /GET \/api\/users\/\{id\}.*UserController#get/);
  assert.match(endpoints, /POST \/api\/users.*UserController#create/);
  assert.match(endpoints, /PreAuthorize/);
  const beans = p.query('op=beans');
  assert.match(beans, /DefaultUserService/);
  assert.match(beans, /client.*Client.*Profile/);
  assert.match(beans, /UserRepository/);
  const config = p.query('op=config', 'query=app.pageSize');
  assert.match(config, /app\.page-size = 10\s+\[default\]/);
  assert.match(config, /app\.page-size = 20\s+\[dev\]/);
  assert.match(config, /@Value app\.page-size/);
  assert.match(config, /@ConfigurationProperties\(prefix\) app/);
  assert.ok(!p.query('op=config', 'query=app.password').includes('integration-private-value'));
});

test('Spring integration: JPA repositories, table migrations and listeners', (t) => {
  const p = fixture(t);
  const entity = p.query('op=entities', 'query=User');
  assert.match(entity, /таблица users/);
  assert.match(entity, /id Long.*PK/);
  assert.match(entity, /email/);
  assert.match(entity, /UserRepository/);
  assert.match(entity, /findByEmail.*@Query/);
  const table = p.query('op=table', 'name=users');
  assert.match(table, /V1__users\.sql/);
  assert.match(table, /email/);
  const listeners = p.query('op=listeners');
  assert.match(listeners, /KafkaListener.*user-events/);
  assert.match(listeners, /EventListener.*UserCreatedEvent/);
  assert.match(listeners, /Scheduled.*1000/);
});

test('index integration: source edits, creation and deletion refresh the public index', (t) => {
  const p = project(t);
  const run = (...args) => {
    const r = p.run(...args);
    assert.equal(r.error, undefined);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.stdout;
  };
  p.write('Before.java', 'public class Before {}');
  assert.match(run('op=symbol', 'name=Before'), /Before.*class.*Before\.java/);
  p.write('Before.java', 'public class AfterChanged {}');
  assert.match(run('op=symbol', 'name=AfterChanged'), /AfterChanged.*class/);
  p.write('New.java', 'public class New {}');
  assert.match(run('op=symbol', 'name=New'), /New.*class/);
  fs.unlinkSync(path.join(p.root, 'Before.java'));
  assert.match(run('op=symbol', 'name=AfterChanged'), /не найдено/);
});
