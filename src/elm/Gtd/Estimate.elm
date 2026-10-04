module Gtd.Estimate exposing
    ( all
    , badge
    , fromKey
    , key
    , label
    )

{-| Roughly how many minutes an Action takes, in the steps `ESTIMATE_MINUTES` lists in
`src/domain/types.ts`: rough on purpose, so the board can filter by it. Optional, like
energy; the host reads any other number as the next step up.
-}

import Html exposing (Html, span, text)
import Html.Attributes exposing (attribute, class)


all : List Int
all =
    [ 5, 15, 30, 60, 120 ]


key : Int -> String
key =
    String.fromInt


fromKey : String -> Maybe Int
fromKey raw =
    String.toInt raw |> Maybe.andThen (\minutes -> List.filter ((==) minutes) all |> List.head)


label : Int -> String
label minutes =
    if minutes < 60 then
        String.fromInt minutes ++ " min"

    else
        String.fromInt (minutes // 60) ++ " h"


{-| The estimate on an Action card: a stopwatch and the time, which read on their own.
-}
badge : Int -> Html msg
badge minutes =
    span [ class "dg-estimate" ]
        [ span [ attribute "aria-hidden" "true" ] [ text "⏱ " ]
        , text (label minutes)
        ]
