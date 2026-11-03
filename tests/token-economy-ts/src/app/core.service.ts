import {Injectable} from '@angular/core';
import {Observable} from 'rxjs';

@Injectable({providedIn: 'root'})
export class CoreService {
    load(): Observable<string> {
        return new Observable<string>();
    }
}
