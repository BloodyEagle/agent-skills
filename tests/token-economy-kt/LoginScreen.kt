package com.example.shop.ui.login

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.example.shop.R

@Composable
fun LoginScreen(viewModel: LoginViewModel, navController: NavController? = null) {
    var login by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }

    Column(modifier = Modifier.padding(16.dp)) {
        TextField(
            value = login,
            onValueChange = { login = it },
            label = { Text(text = stringResource(R.string.login_title)) },
        )
        LoginField(value = password, onValueChange = { password = it })
        Button(onClick = {
            viewModel.submit(login, password)
            navController?.navigate("home")
        }) {
            Text(text = stringResource(R.string.err_network))
        }
    }
}

@Composable
private fun LoginField(
    value: String,
    onValueChange: (String) -> Unit,
) {
    TextField(value = value, onValueChange = onValueChange)
}
