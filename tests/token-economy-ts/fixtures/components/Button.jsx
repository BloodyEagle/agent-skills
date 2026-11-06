export default function Button({label}) {
    return <button aria-label={label}><span>{label}</span></button>;
}
export const render = (label) => <Button label={label} />;
export class Counter {
    #value = 0;
    #increment() {
        this.#value++;
    }
    increment() {
        this.#increment();
    }
}
