module Gtd.Mode exposing (badge, label, symbol)

{-| An Action's mode: the inner state it fits (focused, creative, restless…), where
its context names the surroundings it needs. Modes are free text like contexts, and
optional.
-}

import Html exposing (Html, span, text)
import Html.Attributes exposing (attribute, class)


{-| Marks a mode wherever it is shown, so it doesn't read as a context or a tag.
-}
symbol : String
symbol =
    "◐"


label : String -> String
label mode =
    symbol ++ " " ++ mode


badge : String -> Html msg
badge mode =
    span [ class "dg-card-mode" ]
        [ span [ attribute "aria-hidden" "true" ] [ text (symbol ++ " ") ]
        , span [ class "dg-sr-only" ] [ text "Mode: " ]
        , text mode
        ]
