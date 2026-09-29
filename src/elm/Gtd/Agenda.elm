module Gtd.Agenda exposing (Clock, Moment(..), clock, isToday, moment, soonMinutes, todayActions)

{-| Today's Calendar Actions, which the Action Board shows above its columns
whatever the view filters, and where each stands against the clock.

Times are local wall-clock times: the host sends a timed Action's start as
`scheduledLocal` (`YYYY-MM-DDTHH:mm`), so the board compares it with the local
time here and needs no time zone arithmetic of its own.

-}

import Gtd.ActionStatus as ActionStatus
import Gtd.Data as Data exposing (Action)
import Time


{-| The local day and, once the board has read the clock, the minute of that day.
-}
type alias Clock =
    { day : String, minute : Maybe Int }


{-| How long before its start a timed Action is "up next".
-}
soonMinutes : Int
soonMinutes =
    60


type Moment
    = AllDay
      -- Start and end, `HH:mm`.
    | Later String String
      -- Minutes to go, then start and end.
    | Soon Int String String
      -- The end.
    | Now String
    | Earlier String String


clock : Time.Zone -> Time.Posix -> Clock
clock zone now =
    { day =
        String.fromInt (Time.toYear zone now)
            ++ "-"
            ++ pad (monthNumber (Time.toMonth zone now))
            ++ "-"
            ++ pad (Time.toDay zone now)
    , minute = Just (Time.toHour zone now * 60 + Time.toMinute zone now)
    }


{-| An open Calendar Action on the clock's day.
-}
isToday : Clock -> Action -> Bool
isToday now action =
    action.status == ActionStatus.Scheduled && (Maybe.map Tuple.first (start action) == Just now.day)


{-| Today's Calendar Actions, all-day ones first, then by start time.
-}
todayActions : Clock -> List Action -> List Action
todayActions now actions =
    actions
        |> List.filter (isToday now)
        |> List.sortBy (\action -> ( start action |> Maybe.andThen Tuple.second |> Maybe.withDefault -1, action.title ))


moment : Clock -> Action -> Moment
moment now action =
    case ( Data.schedule action, start action |> Maybe.andThen Tuple.second ) of
        ( Just (Data.Timed _ duration), Just from ) ->
            let
                until =
                    from + duration
            in
            case now.minute of
                Nothing ->
                    Later (clockText from) (clockText until)

                Just minute ->
                    if minute >= until then
                        Earlier (clockText from) (clockText until)

                    else if minute >= from then
                        Now (clockText until)

                    else if from - minute <= soonMinutes then
                        Soon (from - minute) (clockText from) (clockText until)

                    else
                        Later (clockText from) (clockText until)

        _ ->
            AllDay


{-| The local day an Action is on and, for a timed one, its starting minute.
-}
start : Action -> Maybe ( String, Maybe Int )
start action =
    case Data.schedule action of
        Just (Data.AllDay date) ->
            Just ( date, Nothing )

        Just (Data.Timed utc _) ->
            let
                local =
                    Maybe.withDefault utc action.scheduledLocal
            in
            Just
                ( String.left 10 local
                , Maybe.map2 (\hours minutes -> hours * 60 + minutes)
                    (String.toInt (String.slice 11 13 local))
                    (String.toInt (String.slice 14 16 local))
                )

        Nothing ->
            Nothing


{-| `HH:mm` for a minute of the day, wrapping past midnight.
-}
clockText : Int -> String
clockText minute =
    pad (modBy 24 (minute // 60)) ++ ":" ++ pad (modBy 60 minute)


pad : Int -> String
pad number =
    String.padLeft 2 '0' (String.fromInt number)


monthNumber : Time.Month -> Int
monthNumber month =
    case month of
        Time.Jan ->
            1

        Time.Feb ->
            2

        Time.Mar ->
            3

        Time.Apr ->
            4

        Time.May ->
            5

        Time.Jun ->
            6

        Time.Jul ->
            7

        Time.Aug ->
            8

        Time.Sep ->
            9

        Time.Oct ->
            10

        Time.Nov ->
            11

        Time.Dec ->
            12
