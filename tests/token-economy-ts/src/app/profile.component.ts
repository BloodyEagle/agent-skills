import {Component} from '@angular/core';
import {CoreService} from './core.service';

@Component({
    selector: 'app-profile',
    template: '<div>{{ title }}</div>'
})
export class ProfileComponent {
    title = 'profile';

    constructor(private core: CoreService) {}
}
