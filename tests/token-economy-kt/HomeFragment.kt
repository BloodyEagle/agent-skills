package com.example.shop.legacy

import androidx.fragment.app.Fragment
import androidx.navigation.fragment.findNavController

class HomeFragment : Fragment() {

    fun openSettings() {
        findNavController().navigate(R.id.settingsFragment)
    }
}
